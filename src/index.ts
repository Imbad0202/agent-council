import 'dotenv/config';
import { resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { loadAgentConfig, loadCouncilConfig } from './config.js';
import { createProvider } from './worker/providers/factory.js';
import { AgentWorker } from './worker/agent-worker.js';
import { MemoryDB } from './memory/db.js';
import { UsageTracker } from './memory/tracker.js';
import { ParticipationManager } from './council/participation.js';
import { EventBus } from './events/bus.js';
import { GatewayRouter } from './gateway/router.js';
import { IntentGate } from './council/intent-gate.js';
import { DeliberationHandler } from './council/deliberation.js';
import { FacilitatorAgent } from './council/facilitator.js';
import { ActiveRecall } from './memory/active-recall.js';
import { ExecutionDispatcher } from './execution/dispatcher.js';
import { ExecutionReviewer } from './execution/reviewer.js';
import { parseArgs, createAdapter } from './adapters/factory.js';
import { buildRichMetadata } from './adapters/metadata.js';
import type { AdapterFactoryConfig } from './adapters/factory.js';
import type { LLMProvider } from './types.js';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Adapter: ${args.adapter}`);

  const groupChatId = Number(process.env.TELEGRAM_GROUP_CHAT_ID);
  if (args.adapter === 'telegram' && !groupChatId) {
    throw new Error('TELEGRAM_GROUP_CHAT_ID is required for Telegram adapter');
  }

  const memorySyncPath = process.env.MEMORY_SYNC_PATH;
  if (!memorySyncPath) console.log('MEMORY_SYNC_PATH not set — running without external memory');

  const configDir = resolve('config');
  const councilConfig = loadCouncilConfig(resolve(configDir, 'council.yaml'));

  const agentConfigDir = resolve(configDir, 'agents');
  const agentFiles = readdirSync(agentConfigDir).filter((f) => f.endsWith('.yaml'));
  const agentConfigs = agentFiles.map((f) => loadAgentConfig(resolve(agentConfigDir, f)));

  console.log(`[v0.2.1] Loaded ${agentConfigs.length} agents: ${agentConfigs.map((a) => `${a.name}(${a.provider})`).join(', ')}`);

  // Split agents into peers and facilitator
  const peerConfigs = agentConfigs.filter((a) => a.roleType !== 'facilitator');
  const facilitatorConfig = agentConfigs.find((a) => a.roleType === 'facilitator');

  // Cache providers so agents sharing a provider reuse the same client instance
  const providerCache = new Map<string, LLMProvider>();
  function getOrCreateProvider(name: string): LLMProvider {
    if (!providerCache.has(name)) {
      providerCache.set(name, createProvider(name));
    }
    return providerCache.get(name)!;
  }

  // Create peer workers (deliberation participants)
  const peerWorkers = peerConfigs.map((config) => {
    const provider = getOrCreateProvider(config.provider);
    return new AgentWorker(config, provider, memorySyncPath ?? '');
  });

  // Create facilitator worker (if configured)
  let facilitatorWorker: AgentWorker | undefined;
  if (facilitatorConfig) {
    const provider = getOrCreateProvider(facilitatorConfig.provider);
    facilitatorWorker = new AgentWorker(facilitatorConfig, provider, memorySyncPath ?? '');
  }

  // Adapter: abstracts Telegram / CLI transport
  const listenerAgent = councilConfig.participation?.listenerAgent || agentConfigs[0].id;
  const adapterConfig: AdapterFactoryConfig = {
    cli: { verbose: args.verbose },
    telegram: {
      groupChatId,
      agents: agentConfigs,
      listenerAgentId: listenerAgent,
    },
  };
  const adapter = createAdapter(args.adapter, adapterConfig);

  console.log(`Adapter "${args.adapter}" created, listener: ${listenerAgent}`);

  const agentNameMap = new Map(agentConfigs.map((a) => [a.id, a.name]));
  const sendFn = async (agentId: string, content: string, threadId?: number) => {
    const metadata = buildRichMetadata(agentId, agentNameMap);
    await adapter.send(agentId, content, metadata, threadId);
  };

  // ── Event-driven wiring ──────────────────────────────────────────────

  const bus = new EventBus();

  // Infrastructure: main provider for classification & decomposition
  const mainProvider = getOrCreateProvider(agentConfigs[0].provider);

  // Classification layer
  new IntentGate(bus, mainProvider);
  console.log('IntentGate initialized');

  // Memory layer
  if (councilConfig.memory) {
    const memoryDb = new MemoryDB(resolve(councilConfig.memory.dbPath));
    const activeRecall = new ActiveRecall(bus, memoryDb);
    const tracker = new UsageTracker(memoryDb);

    // Track memory references from agent responses
    bus.on('agent.responded', (payload) => {
      const refs = tracker.extractReferences(payload.response.content);
      if (refs.length > 0) tracker.trackReferences(refs);
    });

    console.log('Memory modules initialized (ActiveRecall + UsageTracker)');
    // Keep references alive to prevent GC
    void activeRecall;
  }

  // Deliberation layer
  const deliberationHandler = new DeliberationHandler(
    bus,
    peerWorkers,
    councilConfig,
    sendFn,
    {
      facilitatorWorker,
      sendKeyboardFn: adapter.sendMessageWithKeyboard
        ? adapter.sendMessageWithKeyboard.bind(adapter)
        : undefined,
    },
  );
  console.log('DeliberationHandler initialized');

  // Wire blind-review commands into the listener bot (no-op for adapters without setBlindReviewWiring)
  if (adapter.setBlindReviewWiring) {
    const agentMeta = new Map<string, { name: string; role: string }>();
    for (const agent of agentConfigs) {
      agentMeta.set(agent.id, { name: agent.name ?? agent.id, role: 'tbd' });
    }
    adapter.setBlindReviewWiring({
      store: deliberationHandler.getBlindReviewStore(),
      sendFn: (agentId: string, content: string, threadId?: number) => adapter.send(agentId, content, { agentName: '' }, threadId),
      agentMeta,
      bus,
    });
  }

  // Participation manager
  if (councilConfig.participation) {
    const participationManager = new ParticipationManager(councilConfig.participation, agentConfigs);
    console.log('Participation manager initialized');
    void participationManager;
  }

  // Facilitation layer (if facilitator config exists)
  if (facilitatorWorker) {
    new FacilitatorAgent(bus, facilitatorWorker);
    console.log('FacilitatorAgent initialized');
  }

  // Execution layer (if enabled)
  if (councilConfig.execution?.enabled) {
    new ExecutionDispatcher(bus, councilConfig.execution, mainProvider);
    new ExecutionReviewer(bus, sendFn);
    console.log('Execution modules initialized (Dispatcher + Reviewer)');
  }

  // Gateway (thin router)
  const router = new GatewayRouter(bus, sendFn, councilConfig);
  console.log('GatewayRouter initialized (event-driven)');

  // ── Adapter startup ──────────────────────────────────────────────────

  console.log('Agent Council v0.2.1 starting...');

  await adapter.start((msg) => {
    router.handleHumanMessage({
      id: `${args.adapter}-${Date.now()}`,
      role: 'human',
      content: msg.content,
      timestamp: Date.now(),
      threadId: msg.threadId ?? 0,
    });
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
