import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentConfig } from '../../src/types.js';
import { ResetSnapshotDB } from '../../src/storage/reset-snapshot-db.js';
import { SessionReset } from '../../src/council/session-reset.js';

const mockBot = {
  on: vi.fn(),
  command: vi.fn(),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  api: {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    deleteWebhook: vi.fn().mockResolvedValue(true),
    raw: {
      getUpdates: vi.fn().mockResolvedValue([]),
    },
  },
};

vi.mock('grammy', () => ({
  Bot: vi.fn(() => mockBot),
  InlineKeyboard: vi.fn(),
}));

const { TelegramAdapter } = await import('../../src/adapters/telegram.js');
type TelegramAdapterConfig = import('../../src/adapters/telegram.js').TelegramAdapterConfig;

const agents: AgentConfig[] = [
  {
    id: 'agent-listener',
    name: 'Listener',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    memoryDir: '/tmp',
    personality: 'advocate',
    botTokenEnv: 'BOT_TOKEN_LISTENER',
  },
];

const config: TelegramAdapterConfig = {
  groupChatId: -100123456789,
  agents,
  listenerAgentId: 'agent-listener',
};

function makeFacilitator() {
  return {
    respondDeterministic: vi.fn(async () => ({
      content: '## Decisions\n- x\n\n## Open Questions\n\n## Evidence Pointers\n\n## Blind-Review State\nnone\n',
      tokensUsed: { input: 1, output: 1 },
    })),
  };
}

function makeDelibHandler() {
  return {
    getBlindReviewSessionId: vi.fn(() => null),
    getCurrentTopic: vi.fn(() => 'topic'),
    // Non-empty so round-10 empty-segment guard doesn't short-circuit.
    // Sentinel content is greppable for future maintainers.
    getCurrentSegmentMessages: vi.fn(() => [{ id: 'x', role: 'human', content: 'TEST_DEFAULT_TURN_ROUND10_GUARD', timestamp: 1 }] as readonly unknown[]),
    getSegments: vi.fn(() => [{ snapshotId: null }]),
    isResetInFlight: vi.fn(() => false),
    isDeliberationInFlight: vi.fn(() => false),
    hasPendingClassifications: vi.fn(() => false),
    setResetInFlight: vi.fn(),
    sealCurrentSegment: vi.fn(),
    openNewSegment: vi.fn(),
    unsealCurrentSegment: vi.fn(),
  };
}

describe('TelegramAdapter session-reset wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBot.start.mockResolvedValue(undefined);
    mockBot.api.deleteWebhook.mockResolvedValue(true);
    mockBot.api.raw.getUpdates.mockResolvedValue([]);
    process.env['BOT_TOKEN_LISTENER'] = 'fake:token';
  });

  it('setSessionResetWiring stashes the wiring and passes it into setupListener', async () => {
    const adapter = new TelegramAdapter(config);
    const db = new ResetSnapshotDB(':memory:');
    const reset = new SessionReset(db, makeFacilitator() as never);
    const delib = makeDelibHandler();

    adapter.setSessionResetWiring({ reset, deliberationHandler: delib as never, db });

    await adapter.start(() => {});

    // Register /councilreset and /councilhistory on the listener bot.
    const commandNames = mockBot.command.mock.calls.map((call) => call[0]);
    expect(commandNames).toContain('councilreset');
    expect(commandNames).toContain('councilhistory');

    await adapter.stop();
    db.close();
  });

  it('without setSessionResetWiring, council commands are NOT registered', async () => {
    const adapter = new TelegramAdapter(config);

    await adapter.start(() => {});

    const commandNames = mockBot.command.mock.calls.map((call) => call[0]);
    expect(commandNames).not.toContain('councilreset');
    expect(commandNames).not.toContain('councilhistory');

    await adapter.stop();
  });

  // Round-8 codex finding [P1]: grammY runs middleware in registration order
  // and `on('message:text', defaultTextHandler)` consumes every text update
  // including `/councilreset` unless the command handlers are registered
  // FIRST. Asserting relative ordering by tracking the interleaved call
  // sequence on mockBot.command vs mockBot.on.
  it('registers /councilreset and /councilhistory BEFORE the catch-all message:text handler', async () => {
    const adapter = new TelegramAdapter(config);
    const db = new ResetSnapshotDB(':memory:');
    const reset = new SessionReset(db, makeFacilitator() as never);
    const delib = makeDelibHandler();
    adapter.setSessionResetWiring({ reset, deliberationHandler: delib as never, db });

    // Record the interleaved invocation order across both mocks.
    const order: string[] = [];
    mockBot.command.mockImplementation((name: string) => {
      order.push(`command:${name}`);
    });
    mockBot.on.mockImplementation((filter: string) => {
      order.push(`on:${filter}`);
    });

    await adapter.start(() => {});

    const councilResetIdx = order.indexOf('command:councilreset');
    const councilHistoryIdx = order.indexOf('command:councilhistory');
    const textHandlerIdx = order.indexOf('on:message:text');

    expect(councilResetIdx).toBeGreaterThanOrEqual(0);
    expect(councilHistoryIdx).toBeGreaterThanOrEqual(0);
    expect(textHandlerIdx).toBeGreaterThanOrEqual(0);
    expect(councilResetIdx).toBeLessThan(textHandlerIdx);
    expect(councilHistoryIdx).toBeLessThan(textHandlerIdx);

    await adapter.stop();
    db.close();
  });
});
