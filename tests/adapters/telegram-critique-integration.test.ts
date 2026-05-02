import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentConfig } from '../../src/types.js';

const mockBot = {
  on: vi.fn(),
  command: vi.fn(),
  callbackQuery: vi.fn(),
  catch: vi.fn(),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  api: {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    deleteWebhook: vi.fn().mockResolvedValue(true),
    raw: { getUpdates: vi.fn().mockResolvedValue([]) },
  },
};

const mockRunner = { stop: vi.fn().mockResolvedValue(undefined) };

vi.mock('grammy', async () => {
  const actual = await vi.importActual<typeof import('grammy')>('grammy');
  return { ...actual, Bot: vi.fn(() => mockBot) };
});

vi.mock('@grammyjs/runner', () => ({
  run: vi.fn(() => mockRunner),
}));

const { TelegramAdapter } = await import('../../src/adapters/telegram.js');
const { PendingCritiqueState } = await import('../../src/telegram/critique-state.js');
const { CRITIQUE_CALLBACK_PATTERN } = await import('../../src/telegram/critique-callback.js');

const agents: AgentConfig[] = [
  {
    id: 'listener',
    name: 'Listener',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    memoryDir: '/tmp',
    personality: 'advocate',
  },
];

function makeAdapter() {
  process.env['TELEGRAM_BOT_TOKEN'] = 'fake-token:AAA';
  return new TelegramAdapter({
    groupChatId: 100,
    agents,
    listenerAgentId: 'listener',
  });
}

describe('TelegramAdapter — critique UI integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBot.start.mockResolvedValue(undefined);
    mockBot.stop.mockResolvedValue(undefined);
    mockBot.api.sendMessage.mockResolvedValue({ message_id: 1 });
    mockBot.api.deleteWebhook.mockResolvedValue(true);
    mockBot.api.raw.getUpdates.mockResolvedValue([]);
  });

  it('exposes setCritiqueUiWiring method', () => {
    const adapter = makeAdapter();
    expect(typeof (adapter as any).setCritiqueUiWiring).toBe('function');
  });

  it('after setCritiqueUiWiring + start, registers critique callbackQuery handler', async () => {
    const adapter = makeAdapter();
    const state = new PendingCritiqueState();
    (adapter as any).setCritiqueUiWiring({ state });
    await adapter.start(vi.fn());

    const patterns = mockBot.callbackQuery.mock.calls.map((c) => c[0]);
    expect(patterns).toContainEqual(CRITIQUE_CALLBACK_PATTERN);
  });

  it('without setCritiqueUiWiring, does NOT register critique callback', async () => {
    const adapter = makeAdapter();
    await adapter.start(vi.fn());

    const patterns = mockBot.callbackQuery.mock.calls.map((c) => c[0]);
    expect(patterns).not.toContainEqual(CRITIQUE_CALLBACK_PATTERN);
  });
});
