import { vi } from 'vitest';
import { DeliberationHandler } from '../../src/council/deliberation.js';
import { EventBus } from '../../src/events/bus.js';
import { AgentWorker } from '../../src/worker/agent-worker.js';
import { ResetSnapshotDB } from '../../src/storage/reset-snapshot-db.js';
import { ArtifactDB } from '../../src/council/artifact-db.js';
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

function makeStubProvider(name: string, responseContent: string): StubProvider {
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

  const handler = new DeliberationHandler(bus, workers, minConfig, sendFn, {
    facilitatorWorker,
    resetSnapshotDB: db,
  });

  const sessionReset = new SessionReset(db, new ArtifactDB(':memory:'), facilitatorWorker);

  return {
    handler,
    bus,
    workers,
    sendFn,
    db,
    sessionReset,
    facilitatorWorker,
    providers: { claude, openai, facilitator },
  };
}
