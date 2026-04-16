import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentWorker } from '../../src/worker/agent-worker.js';
import type { AgentConfig, LLMProvider, CouncilMessage } from '../../src/types.js';

const mockProvider: LLMProvider = {
  name: 'mock',
  chat: vi.fn().mockResolvedValue({
    content: 'Considered answer.',
    tokensUsed: { input: 100, output: 50 },
  }),
  summarize: vi.fn().mockResolvedValue('Summary'),
  estimateTokens: vi.fn().mockReturnValue(100),
};

const baseConfig: AgentConfig = {
  id: 'binbin',
  name: '賓賓',
  provider: 'claude',
  model: 'claude-opus-4-7',
  memoryDir: '賓賓/global',
  personality: 'You are 賓賓.',
};

describe('AgentWorker — thinking tier resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes high complexity to thinking config when defined', async () => {
    const config: AgentConfig = {
      ...baseConfig,
      thinking: { high: { budget_tokens: 32000 } },
    };
    const worker = new AgentWorker(config, mockProvider, '/tmp/no-memory');
    const messages: CouncilMessage[] = [
      { id: 'msg-1', role: 'human', content: 'Hard question.', timestamp: Date.now() },
    ];

    await worker.respond(messages, 'analyst', undefined, 'high');

    const chatCall = vi.mocked(mockProvider.chat).mock.calls[0];
    expect(chatCall[1].thinking).toEqual({ type: 'enabled', budget_tokens: 32000 });
  });

  it('does not pass thinking when complexity tier has no config', async () => {
    const config: AgentConfig = {
      ...baseConfig,
      thinking: { high: { budget_tokens: 32000 } },
    };
    const worker = new AgentWorker(config, mockProvider, '/tmp/no-memory');
    const messages: CouncilMessage[] = [
      { id: 'msg-1', role: 'human', content: 'Simple.', timestamp: Date.now() },
    ];

    await worker.respond(messages, 'analyst', undefined, 'low');

    const chatCall = vi.mocked(mockProvider.chat).mock.calls[0];
    expect(chatCall[1].thinking).toBeUndefined();
  });

  it('does not pass thinking when agent has no thinking config at all', async () => {
    const worker = new AgentWorker(baseConfig, mockProvider, '/tmp/no-memory');
    const messages: CouncilMessage[] = [
      { id: 'msg-1', role: 'human', content: 'Anything.', timestamp: Date.now() },
    ];

    await worker.respond(messages, 'analyst', undefined, 'high');

    const chatCall = vi.mocked(mockProvider.chat).mock.calls[0];
    expect(chatCall[1].thinking).toBeUndefined();
  });

  it('does not pass thinking when complexity is not provided', async () => {
    const config: AgentConfig = {
      ...baseConfig,
      thinking: { high: { budget_tokens: 32000 } },
    };
    const worker = new AgentWorker(config, mockProvider, '/tmp/no-memory');
    const messages: CouncilMessage[] = [
      { id: 'msg-1', role: 'human', content: 'No tier.', timestamp: Date.now() },
    ];

    await worker.respond(messages, 'analyst');

    const chatCall = vi.mocked(mockProvider.chat).mock.calls[0];
    expect(chatCall[1].thinking).toBeUndefined();
  });
});
