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
import { SessionReset } from './council/session-reset.js';
import { ResetSnapshotDB } from './storage/reset-snapshot-db.js';
import { ArtifactDB } from './council/artifact-db.js';
import { CliCommandHandler } from './adapters/cli-commands.js';
import { routeCliInput, deriveCliThreadId } from './adapters/cli-dispatch.js';
import { CliSessionManager } from './adapters/cli-sessions.js';
import { BlindReviewDB } from './council/blind-review-db.js';
import { PvgRotateStore } from './council/pvg-rotate-store.js';
import { PvgRotateDB } from './council/pvg-rotate-db.js';
import { HumanCritiqueStore } from './council/human-critique-store.js';
import type { HumanCritiqueWiring, CritiquePromptResult } from './council/human-critique-wiring.js';
import { PendingCritiqueState } from './telegram/critique-state.js';
import {
  createTelegramCritiquePromptUser,
  CRITIQUE_PROMPT_AGENT_ID,
} from './telegram/critique-callback.js';
import type { CritiqueUiAdapter } from './adapters/telegram.js';
import type { DefaultCritiquePromptAdapter } from './adapters/cli.js';
import type { SessionResetAdapter } from './adapters/telegram.js';
import { ActiveRecall } from './memory/active-recall.js';
import { ExecutionDispatcher } from './execution/dispatcher.js';
import { ExecutionReviewer } from './execution/reviewer.js';
import { parseArgs, createAdapter } from './adapters/factory.js';
import { buildRichMetadata } from './adapters/metadata.js';
import type { AdapterFactoryConfig } from './adapters/factory.js';
import { effectiveRoleType, type AgentConfig, type LLMProvider } from './types.js';
import { ArtifactService } from './council/artifact-service.js';
import type { ArtifactAdapter } from './adapters/telegram.js';

function isArtifactAdapter(a: unknown): a is ArtifactAdapter {
  return typeof (a as ArtifactAdapter).setArtifactWiring === 'function';
}

function pickFirstPeerConfig(agents: AgentConfig[]): AgentConfig {
  return agents.find(a => effectiveRoleType(a) === 'peer') ?? agents[0];
}

function hasDefaultPromptUser(a: unknown): a is DefaultCritiquePromptAdapter {
  return typeof (a as DefaultCritiquePromptAdapter).defaultPromptUser === 'function';
}

function hasSetCritiqueUiWiring(a: unknown): a is CritiqueUiAdapter {
  return typeof (a as CritiqueUiAdapter).setCritiqueUiWiring === 'function';
}

function hasSetSessionResetWiring(a: unknown): a is SessionResetAdapter {
  return typeof (a as SessionResetAdapter).setSessionResetWiring === 'function';
}

// Pick the right promptUser (and matching cancelPrompt) for the adapter:
// - CLI adapter: readline-based two-stage picker, no cancel hook needed (the
//   readline prompt already times out with the store window).
// - Telegram adapter: InlineKeyboard 4-button flow. cancelPrompt drains the
//   PendingCritiqueState entry when the store's timer fires first, so we
//   don't run a parallel state-side timer.
// - Anything else: always-skip so deliberation doesn't stall.
function buildPromptUserForAdapter(
  adapter: ReturnType<typeof createAdapter>,
): Pick<HumanCritiqueWiring, 'promptUser' | 'cancelPrompt'> {
  if (hasDefaultPromptUser(adapter)) {
    return { promptUser: adapter.defaultPromptUser.bind(adapter) };
  }
  if (hasSetCritiqueUiWiring(adapter) && adapter.sendMessageWithKeyboard) {
    const state = new PendingCritiqueState();
    adapter.setCritiqueUiWiring({ state });
    const sendKeyboardFn = adapter.sendMessageWithKeyboard.bind(adapter);
    const promptUser = createTelegramCritiquePromptUser({
      state,
      sendKeyboard: (text, keyboard, threadId) =>
        sendKeyboardFn(CRITIQUE_PROMPT_AGENT_ID, text, keyboard, threadId),
    });
    return {
      promptUser,
      cancelPrompt: (threadId: number) => state.resolveSkipped(threadId),
    };
  }
  return { promptUser: async (): Promise<CritiquePromptResult> => ({ kind: 'skipped' }) };
}

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
  const peerConfigs = agentConfigs.filter((a) => effectiveRoleType(a) === 'peer');
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
  const listenerAgent = councilConfig.participation?.listenerAgent || pickFirstPeerConfig(agentConfigs).id;
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
  const mainProvider = getOrCreateProvider(pickFirstPeerConfig(agentConfigs).provider);

  // Classification layer
  new IntentGate(bus, mainProvider, councilConfig.systemModels.intentClassification);
  console.log('IntentGate initialized');

  // Memory layer — DB instance is shared with CliCommandHandler below when
  // the CLI adapter is active so /memories / /memory / /forget see the same
  // rows the deliberation path writes.
  let memoryDb: MemoryDB | undefined;
  if (councilConfig.memory) {
    memoryDb = new MemoryDB(resolve(councilConfig.memory.dbPath));
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
  const pvgRotateStore = new PvgRotateStore();
  const pvgRotateDB = new PvgRotateDB(resolve('data/council.db'));
  const critiqueStore = new HumanCritiqueStore();
  const resetSnapshotDB = new ResetSnapshotDB(resolve('data/council.db'));
  // v0.5.2.a: ArtifactDB shares council.db. Instantiated early so SessionReset
  // can use the cross-table counter. Wired into ArtifactService below.
  const artifactDB = new ArtifactDB(resolve('data/council.db'));
  // v0.5.2 P1-B: DeliberationHandler default-wires a FacilitatorAgent
  // internally when given a facilitatorWorker, so we no longer construct
  // one here. Constructing it externally AND passing facilitatorWorker
  // would double-subscribe deliberation.started / .ended.
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
      pvgRotateStore,
      critiqueStore,
      resetSnapshotDB,
    },
  );
  console.log('DeliberationHandler initialized');

  // Session reset — requires a facilitatorWorker. If none is configured,
  // /councilreset stays unwired and the command reports "not configured".
  const sessionReset = facilitatorWorker
    ? new SessionReset(resetSnapshotDB, artifactDB, facilitatorWorker)
    : undefined;
  if (sessionReset) {
    console.log('SessionReset initialized');
  }

  // ArtifactService — lazy: if no synthesizer config exists, synthesize()
  // will throw MissingSynthesizerConfigError at command time (spec §10).
  // Do NOT fail at startup so facilitator-less deployments still boot.
  const synthesizerConfig = agentConfigs.find(a => effectiveRoleType(a) === 'artifact-synthesizer') ?? null;
  const artifactService = new ArtifactService({
    synthesizerConfig,
    artifactDb: artifactDB,
    resetDb: resetSnapshotDB,
    handler: deliberationHandler,
    bus,
  });
  console.log('ArtifactService initialized' + (synthesizerConfig ? ` (synthesizer: ${synthesizerConfig.id})` : ' (no synthesizer config — /councildone will reply "not configured")'));

  // Wire BlindReviewDB + persist-failed event
  const blindReviewDB = new BlindReviewDB(resolve('data/council.db'));
  const blindReviewStore = deliberationHandler.getBlindReviewStore();
  blindReviewStore.attachDB(blindReviewDB);
  blindReviewStore.onPersistFailed((evt) => {
    bus.emit('blind-review.persist-failed', evt);
    console.error('[blind-review] persist failed:', evt);
  });

  // Wire pvg-rotate callback into the listener bot
  if (adapter.setPvgRotateWiring) {
    adapter.setPvgRotateWiring({
      store: pvgRotateStore,
      db: pvgRotateDB,
      sendFn: (agentId: string, content: string, threadId?: number) => adapter.send(agentId, content, { agentName: '' }, threadId),
      bus,
    });
  }

  // Wire /councilreset + /councilhistory into the listener bot (Telegram
  // only; adapters without setSessionResetWiring silently skip).
  //
  // Round-15 codex finding [P2]: previously this whole block was gated on
  // `sessionReset`, which requires a facilitator agent. Deployments without
  // a facilitator had `sessionReset === undefined` AND the adapter never
  // saw the snapshot DB, so the listener bot didn't register /councilreset
  // or /councilhistory at all — typing them fell through to the catch-all
  // text handler and started a deliberation round. Now we always pass the
  // DB when the adapter supports session-reset wiring; reset /
  // deliberationHandler are only included when facilitator is configured.
  // The command handlers in telegram/bot.ts branch on those optional
  // fields: /councilhistory is fully functional (DB-only dependency) and
  // /councilreset replies "not configured" if facilitator is missing.
  if (hasSetSessionResetWiring(adapter)) {
    adapter.setSessionResetWiring({
      db: resetSnapshotDB,
      ...(sessionReset
        ? { reset: sessionReset, deliberationHandler }
        : {}),
    });
  }

  // Wire /councildone + /councilshow into the listener bot (Telegram only;
  // adapters without setArtifactWiring silently skip).
  if (isArtifactAdapter(adapter)) {
    adapter.setArtifactWiring({ artifactService });
  }

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
      db: blindReviewDB,
      modelConfigForAgent: (agentId: string) => {
        const cfg = agentConfigs.find((a) => a.id === agentId);
        return cfg?.models ?? null;
      },
    });
  }

  // Wire human-critique commands.
  // CLI: defaultPromptUser drives readline stance picker.
  // Telegram: InlineKeyboard flow — four buttons (challenge/question/addPremise/skip)
  // followed by a free-text message for stance submissions.
  if (adapter.setHumanCritiqueWiring && adapter.handleCritiqueRequest) {
    const parts = buildPromptUserForAdapter(adapter);
    adapter.setHumanCritiqueWiring({ store: critiqueStore, ...parts });
    bus.on('human-critique.requested', async (req) => {
      try {
        await adapter.handleCritiqueRequest!(req);
      } catch (err) {
        // Adapter-side failure falls back to skip so the loop doesn't hang.
        critiqueStore.skip(req.threadId, 'user-skip');
        console.error('[human-critique] adapter failure, skipping window:', err);
      }
    });
    console.log('HumanCritiqueStore + adapter wiring initialized');
  }

  // Participation manager
  if (councilConfig.participation) {
    const participationManager = new ParticipationManager(councilConfig.participation, agentConfigs);
    console.log('Participation manager initialized');
    void participationManager;
  }

  // Facilitation layer (default-wired inside DeliberationHandler when
  // facilitatorWorker is configured — see v0.5.2 P1-B note above).
  if (facilitatorWorker) {
    console.log('FacilitatorAgent initialized (default-wired by DeliberationHandler)');
  }

  // Execution layer (if enabled)
  if (councilConfig.execution?.enabled) {
    new ExecutionDispatcher(bus, councilConfig.execution, mainProvider, councilConfig.systemModels.taskDecomposition);
    new ExecutionReviewer(bus, sendFn);
    console.log('Execution modules initialized (Dispatcher + Reviewer)');
  }

  // Gateway (thin router)
  const router = new GatewayRouter(bus, sendFn, councilConfig);
  console.log('GatewayRouter initialized (event-driven)');

  // Round-14 codex finding [P2-W]: derive a per-process threadId for CLI
  // so different CLI invocations don't share /councilreset history via the
  // round-9 restart-safe DB fallback. Computed once per process so the
  // wiring below and the adapter callback further down see the same value.
  const cliThreadId = args.adapter === 'cli' ? deriveCliThreadId() : 0;

  // CLI command dispatcher (scoped to CLI; Telegram has its own bot.command
  // registration path in setupListener).
  const cliCommandHandler =
    args.adapter === 'cli'
      ? new CliCommandHandler(
          new CliSessionManager(resolve('data')),
          // Reuse the memoryDb opened by the Memory layer so both paths see
          // the same rows. When the Memory layer is disabled, fall back to
          // the default brain.db path (memory schema) rather than
          // council.db, which belongs to BlindReview / PvgRotate / Reset
          // snapshot schemas and has a different storage boundary.
          memoryDb ?? new MemoryDB(resolve('data/brain.db')),
          (line) => console.log(line),
          // Round-16 codex finding [P2-CLI]: round-15 fixed Telegram so
          // /councilhistory works in facilitator-less deployments
          // (DB-only dependency), but the CLI ternary kept passing `{}`
          // when sessionReset was undefined — symmetric bug. Now always
          // pass resetSnapshotDB + threadId; sessionReset/
          // deliberationHandler are added only when facilitator wiring
          // exists. CliCommandHandler.councilReset already replies
          // "not configured" when those are missing, and councilHistory
          // works fully on DB + threadId alone.
          {
            resetSnapshotDB,
            // Per-process CLI threadId (round-14 P2-W fix).
            threadId: cliThreadId,
            ...(sessionReset
              ? { sessionReset, deliberationHandler }
              : {}),
          },
          { artifactService, threadId: cliThreadId },
        )
      : undefined;

  // ── Adapter startup ──────────────────────────────────────────────────

  console.log('Agent Council v0.2.1 starting...');

  await adapter.start((msg) => {
    if (cliCommandHandler) {
      // CLI: route slash commands to CliCommandHandler; everything else to
      // router. Use the per-process cliThreadId (round-14 P2-W) so the
      // adapter callback and the CliCommandHandler reset wiring agree on
      // which thread this CLI session lives on. The CLI adapter currently
      // always passes msg.threadId === 0, but we override regardless to
      // make the boundary explicit at the wiring layer.
      void routeCliInput(msg.content, router, cliCommandHandler, cliThreadId);
      return;
    }
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
