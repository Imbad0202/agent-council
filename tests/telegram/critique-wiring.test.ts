import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentConfig } from '../../src/types.js';

// Mock grammy — all new Bot() instances share the same spy object.
const mockBot = {
  on: vi.fn(),
  command: vi.fn(),
  callbackQuery: vi.fn(),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  api: {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    deleteWebhook: vi.fn().mockResolvedValue(true),
    raw: { getUpdates: vi.fn().mockResolvedValue([]) },
  },
};
vi.mock('grammy', async () => {
  const actual = await vi.importActual<typeof import('grammy')>('grammy');
  return {
    ...actual,
    Bot: vi.fn(() => mockBot),
  };
});

const { BotManager } = await import('../../src/telegram/bot.js');
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

function makeManager() {
  process.env['TELEGRAM_BOT_TOKEN'] = 'fake-token:AAA';
  return new BotManager({
    groupChatId: 100,
    agents,
    listenerAgentId: 'listener',
  });
}

describe('BotManager.setupListener — critique UI wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers critique callbackQuery handler when critiqueUiWiring is provided', () => {
    const manager = makeManager();
    const state = new PendingCritiqueState();
    manager.setupListener(
      { handleHumanMessage: vi.fn() },
      { critiqueUi: { state } },
    );

    const patterns = mockBot.callbackQuery.mock.calls.map((call) => call[0]);
    expect(patterns).toContainEqual(CRITIQUE_CALLBACK_PATTERN);
  });

  it('does NOT register critique callback handler when wiring absent', () => {
    const manager = makeManager();
    manager.setupListener({ handleHumanMessage: vi.fn() });

    const patterns = mockBot.callbackQuery.mock.calls.map((call) => call[0]);
    expect(patterns).not.toContainEqual(CRITIQUE_CALLBACK_PATTERN);
  });

  it('message:text handler consumes pending-text critique instead of calling handleHumanMessage', async () => {
    const manager = makeManager();
    const state = new PendingCritiqueState();
    const handleHumanMessage = vi.fn();
    let resolved: unknown;
    state.register(77, {
      resolve: (r) => { resolved = r; },
    });
    state.advanceToText(77, 'challenge');

    manager.setupListener(
      { handleHumanMessage },
      { critiqueUi: { state } },
    );

    // Grab the 'message:text' handler registered on the bot
    const textCall = mockBot.on.mock.calls.find((c) => c[0] === 'message:text');
    expect(textCall).toBeDefined();
    const textHandler = textCall![1] as (ctx: any) => Promise<void>;

    await textHandler({
      chat: { id: 100 },
      from: { is_bot: false },
      message: { text: 'cost ignored', message_thread_id: 77, message_id: 1, chat: { id: 100 }, from: { id: 1, is_bot: false, first_name: 'U' }, date: 0 },
    });

    expect(resolved).toEqual({ kind: 'submitted', stance: 'challenge', content: 'cost ignored' });
    expect(handleHumanMessage).not.toHaveBeenCalled();
  });

  it('message:text falls through to handleHumanMessage when no critique pending', async () => {
    const manager = makeManager();
    const state = new PendingCritiqueState();
    const handleHumanMessage = vi.fn();

    manager.setupListener(
      { handleHumanMessage },
      { critiqueUi: { state } },
    );

    const textCall = mockBot.on.mock.calls.find((c) => c[0] === 'message:text');
    const textHandler = textCall![1] as (ctx: any) => Promise<void>;

    await textHandler({
      chat: { id: 100 },
      from: { is_bot: false },
      message: { text: 'normal', message_thread_id: 42, message_id: 2, chat: { id: 100 }, from: { id: 1, is_bot: false, first_name: 'U' }, date: 0 },
    });

    expect(handleHumanMessage).toHaveBeenCalledTimes(1);
  });
});
