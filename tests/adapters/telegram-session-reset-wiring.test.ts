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
    getCurrentSegmentMessages: vi.fn(() => [] as readonly unknown[]),
    getSegments: vi.fn(() => [{ snapshotId: null }]),
    isResetInFlight: vi.fn(() => false),
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
});
