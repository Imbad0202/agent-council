import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentWorker } from '../../src/worker/agent-worker.js';
import type { AgentConfig, LLMProvider, CouncilMessage } from '../../src/types.js';

const mockProvider: LLMProvider = {
  name: 'mock',
  chat: vi.fn().mockResolvedValue({
    content: 'ok',
    tokensUsed: { input: 10, output: 5 },
  }),
  summarize: vi.fn().mockResolvedValue('s'),
  estimateTokens: vi.fn().mockReturnValue(10),
};

const cachingConfig: AgentConfig = {
  id: 'binbin',
  name: '賓賓',
  provider: 'claude',
  model: 'claude-opus-4-7',
  memoryDir: '賓賓/global',
  personality: 'You are 賓賓.',
  cacheSystemPrompt: true,
};

const plainConfig: AgentConfig = { ...cachingConfig, cacheSystemPrompt: undefined };

describe('AgentWorker — system prompt caching', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends multi-part systemPrompt with stable prefix cacheable when cacheSystemPrompt=true', async () => {
    const worker = new AgentWorker(cachingConfig, mockProvider, '/tmp/no-memory');
    const messages: CouncilMessage[] = [
      { id: 'm', role: 'human', content: 'q', timestamp: Date.now() },
    ];

    await worker.respond(messages, 'critic');

    const options = vi.mocked(mockProvider.chat).mock.calls[0][1];
    expect(Array.isArray(options.systemPrompt)).toBe(true);
    const parts = options.systemPrompt as Array<{ text: string; cache?: boolean }>;
    expect(parts[0].cache).toBe(true);
    expect(parts[0].text).toContain('You are 賓賓');
    expect(parts[1].cache).toBeUndefined();
    expect(parts[1].text).toContain('critic');
  });

  it('sends plain string systemPrompt when cacheSystemPrompt is not set (regression)', async () => {
    const worker = new AgentWorker(plainConfig, mockProvider, '/tmp/no-memory');
    const messages: CouncilMessage[] = [
      { id: 'm', role: 'human', content: 'q', timestamp: Date.now() },
    ];

    await worker.respond(messages, 'critic');

    const options = vi.mocked(mockProvider.chat).mock.calls[0][1];
    expect(typeof options.systemPrompt).toBe('string');
    expect(options.systemPrompt).toContain('You are 賓賓');
    expect(options.systemPrompt).toContain('critic');
  });
});
