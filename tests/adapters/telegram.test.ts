import { describe, it, expect, vi, beforeEach } from 'vitest';
import { run } from '@grammyjs/runner';
import type { AgentConfig } from '../../src/types.js';
import type { InputAdapter, OutputAdapter } from '../../src/adapters/types.js';

// ---------------------------------------------------------------------------
// Build a single shared mock-bot instance so every `new Bot(...)` call in
// BotManager hands back the same spy object, regardless of which agent token
// is used.
// ---------------------------------------------------------------------------
const mockBot = {
  on: vi.fn(),
  command: vi.fn(),
  catch: vi.fn(),
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

const mockRunner = {
  stop: vi.fn().mockResolvedValue(undefined),
};

vi.mock('grammy', () => ({
  Bot: vi.fn(() => mockBot),
}));

vi.mock('@grammyjs/runner', () => ({
  run: vi.fn(() => mockRunner),
}));

// Import AFTER the mock is registered
const { TelegramAdapter } = await import('../../src/adapters/telegram.js');
type TelegramAdapterConfig = import('../../src/adapters/telegram.js').TelegramAdapterConfig;

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------
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
  {
    id: 'agent-alpha',
    name: 'Alpha',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    memoryDir: '/tmp',
    personality: 'critic',
    botTokenEnv: 'BOT_TOKEN_ALPHA',
  },
];

const config: TelegramAdapterConfig = {
  groupChatId: -100123456789,
  agents,
  listenerAgentId: 'agent-listener',
};

function makeAdapter(): InstanceType<typeof TelegramAdapter> {
  process.env['BOT_TOKEN_LISTENER'] = 'fake-token-listener:AAA';
  process.env['BOT_TOKEN_ALPHA'] = 'fake-token-alpha:BBB';
  return new TelegramAdapter(config);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('TelegramAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply default implementations after clearAllMocks
    mockBot.start.mockResolvedValue(undefined);
    mockBot.stop.mockResolvedValue(undefined);
    mockBot.api.sendMessage.mockResolvedValue({ message_id: 1 });
    mockBot.api.deleteWebhook.mockResolvedValue(true);
    mockBot.api.raw.getUpdates.mockResolvedValue([]);
    mockRunner.stop.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  describe('interface compliance', () => {
    it('implements InputAdapter (has start and stop)', () => {
      const adapter = makeAdapter();
      expect(typeof adapter.start).toBe('function');
      expect(typeof adapter.stop).toBe('function');
      const asInput: InputAdapter = adapter; // compile-time structural check
      expect(asInput).toBeDefined();
    });

    it('implements OutputAdapter (has send and sendSystem)', () => {
      const adapter = makeAdapter();
      expect(typeof adapter.send).toBe('function');
      expect(typeof adapter.sendSystem).toBe('function');
      const asOutput: OutputAdapter = adapter;
      expect(asOutput).toBeDefined();
    });

    it('is simultaneously both InputAdapter and OutputAdapter', () => {
      const adapter = makeAdapter();
      const asInput: InputAdapter = adapter;
      const asOutput: OutputAdapter = adapter;
      expect(asInput).toBe(asOutput);
    });
  });

  // -------------------------------------------------------------------------
  describe('send()', () => {
    it('delegates to BotManager.sendMessage — api.sendMessage is called', async () => {
      const adapter = makeAdapter();
      await adapter.send('agent-alpha', 'Hello from Alpha', { agentName: 'Alpha' }, 42);
      expect(mockBot.api.sendMessage).toHaveBeenCalled();
    });

    it('sends message without threadId (no message_thread_id in options)', async () => {
      const adapter = makeAdapter();
      await adapter.send('agent-alpha', 'No thread', { agentName: 'Alpha' });
      expect(mockBot.api.sendMessage).toHaveBeenCalledWith(
        config.groupChatId,
        'No thread',
        {},
      );
    });

    it('sends message with threadId → message_thread_id in options', async () => {
      const adapter = makeAdapter();
      await adapter.send('agent-alpha', 'In a thread', { agentName: 'Alpha' }, 99);
      expect(mockBot.api.sendMessage).toHaveBeenCalledWith(
        config.groupChatId,
        'In a thread',
        { message_thread_id: 99 },
      );
    });

    it('uses agentName from metadata as display prefix when bot falls back', async () => {
      // For an unknown agentId BotManager uses the fallback bot and prefixes name
      const adapter = makeAdapter();
      await adapter.send('unknown-agent', 'Fallback message', { agentName: 'FallbackName' });
      const callArgs = mockBot.api.sendMessage.mock.calls[0];
      expect(callArgs?.[1]).toContain('FallbackName');
      expect(callArgs?.[1]).toContain('Fallback message');
    });
  });

  // -------------------------------------------------------------------------
  describe('sendSystem()', () => {
    it('calls api.sendMessage at least once', async () => {
      const adapter = makeAdapter();
      await adapter.sendSystem('System announcement');
      expect(mockBot.api.sendMessage).toHaveBeenCalled();
    });

    it('message text contains the provided content', async () => {
      const adapter = makeAdapter();
      await adapter.sendSystem('System announcement');
      const callArgs = mockBot.api.sendMessage.mock.calls[0];
      expect(callArgs?.[1]).toContain('System announcement');
    });

    it('propagates threadId as message_thread_id', async () => {
      const adapter = makeAdapter();
      await adapter.sendSystem('Thread system message', 77);
      const callArgs = mockBot.api.sendMessage.mock.calls[0];
      expect(callArgs?.[2]).toEqual({ message_thread_id: 77 });
    });

    it('sends to the configured groupChatId', async () => {
      const adapter = makeAdapter();
      await adapter.sendSystem('Test');
      const callArgs = mockBot.api.sendMessage.mock.calls[0];
      expect(callArgs?.[0]).toBe(config.groupChatId);
    });
  });

  // -------------------------------------------------------------------------
  describe('start()', () => {
    it('calls deleteWebhook with drop_pending_updates', async () => {
      const adapter = makeAdapter();
      await adapter.start(vi.fn());
      expect(mockBot.api.deleteWebhook).toHaveBeenCalledWith({
        drop_pending_updates: true,
      });
    });

    it('calls getUpdates to acquire polling slot', async () => {
      const adapter = makeAdapter();
      await adapter.start(vi.fn());
      expect(mockBot.api.raw.getUpdates).toHaveBeenCalled();
    });

    it('calls run(bot) for concurrent dispatch (v0.5.4 §3.5)', async () => {
      const adapter = makeAdapter();
      await adapter.start(vi.fn());
      expect(run).toHaveBeenCalledWith(mockBot);
    });

    it('installs bot.catch() before run() (v0.5.4 §3.5 Step 5)', async () => {
      const adapter = makeAdapter();
      await adapter.start(vi.fn());
      expect(mockBot.catch).toHaveBeenCalled();
    });

    it('registers message:text listener via bot.on', async () => {
      const adapter = makeAdapter();
      await adapter.start(vi.fn());
      expect(mockBot.on).toHaveBeenCalledWith('message:text', expect.any(Function));
    });

    it('invokes onMessage callback when a human message arrives', async () => {
      const adapter = makeAdapter();
      const onMessage = vi.fn();
      await adapter.start(onMessage);

      // Grab the handler registered via bot.on('message:text', handler)
      const registeredHandler: Function = mockBot.on.mock.calls.find(
        (call) => call[0] === 'message:text',
      )?.[1];
      expect(registeredHandler).toBeDefined();

      // Simulate a non-bot text message arriving in the group chat
      const fakeCtx = {
        chat: { id: config.groupChatId },
        from: { is_bot: false, id: 1, first_name: 'User' },
        message: {
          message_id: 100,
          text: 'Hello council!',
          date: 1712900000,
          message_thread_id: undefined,
        },
      };
      await registeredHandler(fakeCtx);

      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'Hello council!' }),
      );
    });

    it('does NOT invoke onMessage for messages from bots', async () => {
      const adapter = makeAdapter();
      const onMessage = vi.fn();
      await adapter.start(onMessage);

      const registeredHandler: Function = mockBot.on.mock.calls.find(
        (call) => call[0] === 'message:text',
      )?.[1];

      const fakeBotCtx = {
        chat: { id: config.groupChatId },
        from: { is_bot: true, id: 999, first_name: 'SomeBot' },
        message: {
          message_id: 101,
          text: 'Bot message',
          date: 1712900001,
        },
      };
      await registeredHandler(fakeBotCtx);
      expect(onMessage).not.toHaveBeenCalled();
    });

    it('does NOT invoke onMessage for messages from different chat', async () => {
      const adapter = makeAdapter();
      const onMessage = vi.fn();
      await adapter.start(onMessage);

      const registeredHandler: Function = mockBot.on.mock.calls.find(
        (call) => call[0] === 'message:text',
      )?.[1];

      const wrongChatCtx = {
        chat: { id: -999 }, // wrong group
        from: { is_bot: false, id: 1, first_name: 'User' },
        message: { message_id: 102, text: 'Wrong chat', date: 1712900002 },
      };
      await registeredHandler(wrongChatCtx);
      expect(onMessage).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe('stop()', () => {
    it('calls runner.stop after start (v0.5.4 §3.5 Step 3 — realistic shutdown path)', async () => {
      // [round-9 P2-r9-2] Test contract change: call start() first so this.runner
      // is set, then stop(). The earlier 'stop without start' pattern is now
      // a silent no-op via the if (!this.runner) return guard.
      const adapter = makeAdapter();
      await adapter.start(vi.fn());
      await adapter.stop();
      expect(mockRunner.stop).toHaveBeenCalled();
    });

    it('stop-before-start is safe no-op (v0.5.4 round-6 P1-r6-1 guard)', async () => {
      const adapter = makeAdapter();
      await expect(adapter.stop()).resolves.toBeUndefined();
      expect(mockRunner.stop).not.toHaveBeenCalled();
    });
  });
});
