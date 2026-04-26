import { vi } from 'vitest';
import { DeliberationHandler } from '../../src/council/deliberation.js';
import { EventBus } from '../../src/events/bus.js';
import { AgentWorker } from '../../src/worker/agent-worker.js';
import { ResetSnapshotDB } from '../../src/storage/reset-snapshot-db.js';
import { ArtifactDB } from '../../src/council/artifact-db.js';
import { ArtifactService } from '../../src/council/artifact-service.js';
import { SessionReset } from '../../src/council/session-reset.js';
import type {
  AgentConfig,
  LLMProvider,
  ProviderMessage,
  ProviderResponse,
} from '../../src/types.js';
import { makeWorker, minConfig } from '../council/helpers.js';

export interface TestHandlerBundle {
  handler: DeliberationHandler;
  bus: EventBus;
  workers: AgentWorker[];
  sendFn: ReturnType<typeof vi.fn>;
}

export function buildTestHandler(): TestHandlerBundle {
  const bus = new EventBus();
  const workers = [
    makeWorker('agent-a', 'Agent A'),
    makeWorker('agent-b', 'Agent B'),
  ];
  const sendFn = vi.fn().mockResolvedValue(undefined);
  const handler = new DeliberationHandler(bus, workers, minConfig, sendFn);
  return { handler, bus, workers, sendFn };
}

export interface StubProvider {
  provider: LLMProvider;
  calls: { messages: ProviderMessage[] }[];
}

export function makeStubProvider(name: string, responseContent: string): StubProvider {
  const calls: { messages: ProviderMessage[] }[] = [];
  const provider: LLMProvider = {
    name,
    chat: vi.fn(async (messages: ProviderMessage[]) => {
      // Record a shallow copy of each call's messages array so later pushes
      // to the same array reference don't contaminate earlier call history.
      calls.push({ messages: [...messages] });
      return {
        content: responseContent,
        tokensUsed: { input: 10, output: 10 },
      } satisfies ProviderResponse;
    }),
    summarize: vi.fn(async () => ''),
    estimateTokens: vi.fn().mockReturnValue(0),
  };
  return { provider, calls };
}

export interface RealHandlerBundle {
  handler: DeliberationHandler;
  bus: EventBus;
  workers: AgentWorker[];
  sendFn: ReturnType<typeof vi.fn>;
  db: ResetSnapshotDB;
  // Single ArtifactDB instance shared by SessionReset (for reading
  // segment_index from sealed artifacts in computeNextSegmentIndex) and any
  // ArtifactService composed on top of this bundle. Two distinct :memory:
  // instances would silently break the cross-table monotonic counter — each
  // side would only see half the segment_index history.
  artifactDb: ArtifactDB;
  sessionReset: SessionReset;
  facilitatorWorker: AgentWorker;
  providers: {
    claude: StubProvider;
    openai: StubProvider;
    facilitator: StubProvider;
  };
}

export interface BuildRealHandlerOptions {
  facilitatorSummary?: string;
  agentResponse?: string;
}

// Builds a DeliberationHandler with REAL AgentWorker instances wired to stub
// LLMProviders (chat is a vi.fn that records every call). Use this for
// end-to-end carry-forward assertions (T9 integration test) where the test
// needs to observe what actually arrives at provider.chat().
export function buildRealHandler(options: BuildRealHandlerOptions = {}): RealHandlerBundle {
  const agentResponse = options.agentResponse ?? 'agent response';
  const facilitatorSummary =
    options.facilitatorSummary ??
    [
      '## Decisions',
      '- ship rust',
      '',
      '## Open Questions',
      '- coverage?',
      '',
      '## Evidence Pointers',
      '- turn 2',
      '',
      '## Blind-Review State',
      'none',
      '',
    ].join('\n');

  const bus = new EventBus();

  const claude = makeStubProvider('claude', agentResponse);
  const openai = makeStubProvider('openai', agentResponse);
  const facilitator = makeStubProvider('claude', facilitatorSummary);

  const baseAgentConfig: Omit<AgentConfig, 'id' | 'name' | 'provider'> = {
    model: 'test-model',
    memoryDir: 'test/memory',
    personality: 'test personality',
  };

  const workerA = new AgentWorker(
    { id: 'agent-a', name: 'Agent A', provider: 'claude', ...baseAgentConfig },
    claude.provider,
    '/tmp/no-memory',
  );
  const workerB = new AgentWorker(
    { id: 'agent-b', name: 'Agent B', provider: 'openai', ...baseAgentConfig },
    openai.provider,
    '/tmp/no-memory',
  );
  const facilitatorWorker = new AgentWorker(
    { id: 'facilitator', name: 'Facilitator', provider: 'claude', ...baseAgentConfig },
    facilitator.provider,
    '/tmp/no-memory',
  );

  const workers = [workerA, workerB];
  const sendFn = vi.fn().mockResolvedValue(undefined);
  const db = new ResetSnapshotDB(':memory:');
  const artifactDb = new ArtifactDB(':memory:');

  const handler = new DeliberationHandler(bus, workers, minConfig, sendFn, {
    facilitatorWorker,
    resetSnapshotDB: db,
  });

  const sessionReset = new SessionReset(db, artifactDb, facilitatorWorker);

  return {
    handler,
    bus,
    workers,
    sendFn,
    db,
    artifactDb,
    sessionReset,
    facilitatorWorker,
    providers: { claude, openai, facilitator },
  };
}

// ---------------------------------------------------------------------------
// ArtifactBundle — composes RealHandlerBundle + ArtifactService for
// /councildone integration tests. The caller MUST declare:
//
//   vi.mock('../../src/worker/providers/factory.js', () => ({
//     createProvider: vi.fn(),
//   }));
//
// in their test file (vi.mock is hoisted per-file, not per-function), and
// configure the mock before calling buildArtifactBundle. The synthProvider
// parameter is what createProvider should return for the synthesizer call.
// ---------------------------------------------------------------------------

export interface ArtifactBundle extends RealHandlerBundle {
  artifactService: ArtifactService;
  // artifactDb is inherited from RealHandlerBundle — same instance that
  // SessionReset uses for cross-table segment counter reads.
  synthProvider: StubProvider;
  synthesizerConfig: AgentConfig;
}

export interface BuildArtifactBundleOptions extends BuildRealHandlerOptions {
  /** Canned response body the synthesizer provider will return. Must contain ## TL;DR. */
  artifactBody?: string;
}

/** Default valid artifact body used when no override is provided. */
export const DEFAULT_ARTIFACT_BODY = [
  '## TL;DR',
  '',
  'The council chose option A over B for performance reasons.',
  '',
  '## Discussion',
  '',
  'Agents debated trade-offs between speed and maintainability.',
  '',
  '## Open questions',
  '',
  'How do we measure performance in production?',
  '',
  '## Suggested next step',
  '',
  'Run a benchmark suite before the next release.',
].join('\n');

// The synthesizer AgentConfig used by ArtifactService in integration tests.
export const SYNTH_AGENT_CONFIG: AgentConfig = {
  id: 'synth',
  name: 'Synth',
  provider: 'mock-synth',
  model: 'mock-synth-model',
  memoryDir: '.',
  personality: '',
  roleType: 'artifact-synthesizer',
};

/**
 * Builds a full ArtifactBundle: all RealHandlerBundle pieces + ArtifactService
 * wired to a shared ArtifactDB and the same ResetSnapshotDB used by SessionReset.
 *
 * USAGE — in each integration test file that imports this function, you MUST
 * declare the following mock at the top of the file (vitest hoists vi.mock
 * per-file, not per-function, so it cannot live inside the factory):
 *
 *   vi.mock('../../src/worker/providers/factory.js', () => ({
 *     createProvider: vi.fn(),
 *   }));
 *
 * After building the bundle, wire the factory mock so ArtifactService.synthesize
 * uses the stub:
 *
 *   vi.mocked(createProvider).mockReturnValue(bundle.synthProvider.provider);
 */
export function buildArtifactBundle(options: BuildArtifactBundleOptions = {}): ArtifactBundle {
  const artifactBody = options.artifactBody ?? DEFAULT_ARTIFACT_BODY;
  const base = buildRealHandler(options);

  // CRITICAL: reuse base.artifactDb so SessionReset and ArtifactService
  // see the SAME artifact rows. computeNextSegmentIndex reads from the
  // ArtifactDB instance passed in — two distinct :memory: DBs would each
  // see only half of the cross-table segment_index history.
  const synthProvider = makeStubProvider('mock-synth', artifactBody);

  const artifactService = new ArtifactService({
    synthesizerConfig: SYNTH_AGENT_CONFIG,
    artifactDb: base.artifactDb,
    resetDb: base.db,
    handler: base.handler,
    bus: base.bus,
  });

  return {
    ...base,
    artifactService,
    synthProvider,
    synthesizerConfig: SYNTH_AGENT_CONFIG,
  };
}
