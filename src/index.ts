import 'dotenv/config';
import { resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { loadAgentConfig, loadCouncilConfig } from './config.js';
import { createProvider } from './worker/providers/factory.js';
import { AgentWorker } from './worker/agent-worker.js';
import { BotManager } from './telegram/bot.js';
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
import type { LLMProvider } from './types.js';

async function main() {
  const groupChatId = Number(process.env.TELEGRAM_GROUP_CHAT_ID);
  if (!groupChatId) throw new Error('TELEGRAM_GROUP_CHAT_ID is required');

  const memorySyncPath = process.env.MEMORY_SYNC_PATH;
  if (!memorySyncPath) console.log('MEMORY_SYNC_PATH not set — running without external memory');

  const configDir = resolve('config');
  const councilConfig = loadCouncilConfig(resolve(configDir, 'council.yaml'));

  const agentConfigDir = resolve(configDir, 'agents');
  const agentFiles = readdirSync(agentConfigDir).filter((f) => f.endsWith('.yaml'));
  const agentConfigs = agentFiles.map((f) => loadAgentConfig(resolve(agentConfigDir, f)));

  console.log(`[v0.2.0] Loaded ${agentConfigs.length} agents: ${agentConfigs.map((a) => `${a.name}(${a.provider})`).join(', ')}`);

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

  // Bot manager: one bot per agent (all agents including facilitator)
  const listenerAgent = councilConfig.participation?.listenerAgent || agentConfigs[0].id;
  const botManager = new BotManager({
    groupChatId,
    agents: agentConfigs,
    listenerAgentId: listenerAgent,
  });

  console.log(`Bot manager: ${botManager.getBotCount()} bots, listener: ${listenerAgent}`);

  // Multi-bot send function
  const sendFn = async (agentId: string, content: string, threadId?: number) => {
    const agentName = agentConfigs.find((a) => a.id === agentId)?.name ?? agentId;
    await botManager.sendMessage(agentId, agentName, content, threadId);
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
  new DeliberationHandler(bus, peerWorkers, councilConfig, sendFn);
  console.log('DeliberationHandler initialized');

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

  // ── Telegram startup ─────────────────────────────────────────────────

  botManager.setupListener(router);

  const listenerBot = botManager.getListenerBot();

  console.log('Agent Council v0.2.0 starting...');
  console.log(`Group chat ID: ${groupChatId}`);

  await listenerBot.api.deleteWebhook({ drop_pending_updates: true });

  console.log('Waiting for clean Telegram polling slot...');
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await listenerBot.api.raw.getUpdates({ offset: -1, limit: 1, timeout: 1 });
      console.log('Polling slot acquired.');
      break;
    } catch (err: unknown) {
      const isConflict = err instanceof Error && err.message.includes('409');
      if (isConflict && attempt < 6) {
        console.log(`  Stale connection (attempt ${attempt}/6), waiting 5s...`);
        await new Promise((r) => setTimeout(r, 5_000));
      } else if (!isConflict) {
        break;
      } else {
        console.log('  Could not acquire clean slot, starting anyway...');
      }
    }
  }

  await listenerBot.start({
    drop_pending_updates: true,
    onStart: () => console.log('Agent Council v0.2.0 is running! Send a message in the Telegram group.'),
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
