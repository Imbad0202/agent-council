import { describe, it, expect, vi, beforeAll } from 'vitest';

// ---------------------------------------------------------------------------
// Mock grammy before any TelegramAdapter import resolves
// ---------------------------------------------------------------------------
vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    api: {
      sendMessage: vi.fn(),
      deleteWebhook: vi.fn(),
      raw: { getUpdates: vi.fn() },
    },
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

// Set a fake token so BotManager constructor doesn't throw
process.env['BOT_TOKEN_LISTENER'] = 'fake-token-listener:AAA';
process.env['BOT_TOKEN_ALPHA'] = 'fake-token-alpha:BBB';

// Import AFTER mocks are registered
const { parseArgs, createAdapter } = await import('../../src/adapters/factory.js');
const { CliAdapter } = await import('../../src/adapters/cli.js');
const { TelegramAdapter } = await import('../../src/adapters/telegram.js');

import type { AdapterFactoryConfig } from '../../src/adapters/factory.js';
import type { AgentConfig } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Shared fixtures
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

const factoryConfig: AdapterFactoryConfig = {
  cli: { verbose: false },
  telegram: {
    groupChatId: -100123456789,
    agents,
    listenerAgentId: 'agent-listener',
  },
};

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------
describe('parseArgs', () => {
  it('defaults adapter to telegram when no --adapter flag is given', () => {
    const result = parseArgs([]);
    expect(result.adapter).toBe('telegram');
  });

  it('defaults verbose to false when --verbose is absent', () => {
    const result = parseArgs([]);
    expect(result.verbose).toBe(false);
  });

  it('defaults message to undefined when no positional arg is given', () => {
    const result = parseArgs([]);
    expect(result.message).toBeUndefined();
  });

  it('parses --adapter=cli', () => {
    const result = parseArgs(['--adapter=cli']);
    expect(result.adapter).toBe('cli');
  });

  it('parses --adapter=telegram explicitly', () => {
    const result = parseArgs(['--adapter=telegram']);
    expect(result.adapter).toBe('telegram');
  });

  it('sets verbose=true when --verbose is present', () => {
    const result = parseArgs(['--verbose']);
    expect(result.verbose).toBe(true);
  });

  it('captures a positional (non-flag) argument as message', () => {
    const result = parseArgs(['hello']);
    expect(result.message).toBe('hello');
  });

  it('ignores --prefixed args as message candidates', () => {
    const result = parseArgs(['--adapter=cli', '--verbose']);
    expect(result.message).toBeUndefined();
  });

  it('handles combined flags and positional arg', () => {
    const result = parseArgs(['--adapter=cli', '--verbose', 'my message']);
    expect(result.adapter).toBe('cli');
    expect(result.verbose).toBe(true);
    expect(result.message).toBe('my message');
  });

  it('last positional arg wins when multiple are provided', () => {
    const result = parseArgs(['first', 'second']);
    // The loop assigns each positional; second overwrites first
    expect(result.message).toBe('second');
  });
});

// ---------------------------------------------------------------------------
// createAdapter
// ---------------------------------------------------------------------------
describe('createAdapter', () => {
  it('creates a CliAdapter instance when name is "cli"', () => {
    const adapter = createAdapter('cli', factoryConfig);
    expect(adapter).toBeInstanceOf(CliAdapter);
  });

  it('creates a TelegramAdapter instance when name is "telegram"', () => {
    const adapter = createAdapter('telegram', factoryConfig);
    expect(adapter).toBeInstanceOf(TelegramAdapter);
  });

  it('throws for an unknown adapter name', () => {
    expect(() => createAdapter('unknown', factoryConfig)).toThrow(
      /Unknown adapter: unknown/,
    );
  });

  it('error message for unknown adapter lists available options', () => {
    expect(() => createAdapter('slack', factoryConfig)).toThrow(
      /Available: telegram, cli/,
    );
  });

  it('CliAdapter created with verbose=false from config', () => {
    const adapter = createAdapter('cli', { ...factoryConfig, cli: { verbose: false } });
    expect(adapter).toBeInstanceOf(CliAdapter);
    expect((adapter as InstanceType<typeof CliAdapter>).verbose).toBe(false);
  });

  it('CliAdapter created with verbose=true from config', () => {
    const adapter = createAdapter('cli', { ...factoryConfig, cli: { verbose: true } });
    expect((adapter as InstanceType<typeof CliAdapter>).verbose).toBe(true);
  });

  it('returned CliAdapter satisfies Adapter interface (has start, stop, send, sendSystem)', () => {
    const adapter = createAdapter('cli', factoryConfig);
    expect(typeof adapter.start).toBe('function');
    expect(typeof adapter.stop).toBe('function');
    expect(typeof adapter.send).toBe('function');
    expect(typeof adapter.sendSystem).toBe('function');
  });

  it('returned TelegramAdapter satisfies Adapter interface (has start, stop, send, sendSystem)', () => {
    const adapter = createAdapter('telegram', factoryConfig);
    expect(typeof adapter.start).toBe('function');
    expect(typeof adapter.stop).toBe('function');
    expect(typeof adapter.send).toBe('function');
    expect(typeof adapter.sendSystem).toBe('function');
  });
});
