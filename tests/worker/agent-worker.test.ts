import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentWorker } from '../../src/worker/agent-worker.js';
import type { AgentConfig, LLMProvider, CouncilMessage, AgentRole } from '../../src/types.js';

const mockProvider: LLMProvider = {
  name: 'mock',
  chat: vi.fn().mockResolvedValue({
    content: 'I disagree. The approach has flaws in scalability.',
    tokensUsed: { input: 200, output: 80 },
  }),
  summarize: vi.fn().mockResolvedValue('Summary'),
  estimateTokens: vi.fn().mockReturnValue(100),
};

const agentConfig: AgentConfig = {
  id: 'huahua',
  name: '花花',
  provider: 'claude',
  model: 'claude-opus-4-6',
  memoryDir: '花花/global',
  personality: 'You are 花花.',
};

describe('AgentWorker', () => {
  let worker: AgentWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    worker = new AgentWorker(agentConfig, mockProvider, '/tmp/no-memory');
  });

  it('generates a response to a message', async () => {
    const messages: CouncilMessage[] = [
      { id: 'msg-1', role: 'human', content: 'Should we use microservices?', timestamp: Date.now() },
    ];

    const response = await worker.respond(messages, 'critic');
    expect(response.content).toContain('disagree');
    expect(mockProvider.chat).toHaveBeenCalledOnce();
  });

  it('passes system prompt with role to provider', async () => {
    const messages: CouncilMessage[] = [
      { id: 'msg-1', role: 'human', content: 'Hello', timestamp: Date.now() },
    ];

    await worker.respond(messages, 'advocate');

    const chatCall = vi.mocked(mockProvider.chat).mock.calls[0];
    const options = chatCall[1];
    expect(options.systemPrompt).toContain('advocate');
    expect(options.systemPrompt).toContain('花花');
  });

  it('tracks stats after responding', async () => {
    const messages: CouncilMessage[] = [
      { id: 'msg-1', role: 'human', content: 'Hello', timestamp: Date.now() },
    ];

    await worker.respond(messages, 'critic');
    const stats = worker.getStats();
    expect(stats.responseCount).toBe(1);
  });

  it('exposes agent id and name', () => {
    expect(worker.id).toBe('huahua');
    expect(worker.name).toBe('花花');
  });

  describe('model tier resolution', () => {
    it('uses complexity tier to select model when config has models map', async () => {
      const tieredConfig: AgentConfig = {
        ...agentConfig,
        model: 'claude-haiku-3-5',
        models: { low: 'claude-haiku-3-5', medium: 'claude-sonnet-4-5', high: 'claude-opus-4-6' },
      };
      const tieredWorker = new AgentWorker(tieredConfig, mockProvider, '/tmp/no-memory');
      const messages: CouncilMessage[] = [
        { id: 'msg-1', role: 'human', content: 'Complex question', timestamp: Date.now() },
      ];

      await tieredWorker.respond(messages, 'analyst', undefined, 'high');

      const chatCall = vi.mocked(mockProvider.chat).mock.calls[0];
      expect(chatCall[1].model).toBe('claude-opus-4-6');
    });

    it('falls back to config.model when no models map is defined', async () => {
      const messages: CouncilMessage[] = [
        { id: 'msg-1', role: 'human', content: 'Simple question', timestamp: Date.now() },
      ];

      await worker.respond(messages, 'analyst', undefined, 'high');

      const chatCall = vi.mocked(mockProvider.chat).mock.calls[0];
      expect(chatCall[1].model).toBe('claude-opus-4-6');
    });

    it('tracks model usage in stats after respond()', async () => {
      const tieredConfig: AgentConfig = {
        ...agentConfig,
        model: 'claude-haiku-3-5',
        models: { low: 'claude-haiku-3-5', medium: 'claude-sonnet-4-5', high: 'claude-opus-4-6' },
      };
      const tieredWorker = new AgentWorker(tieredConfig, mockProvider, '/tmp/no-memory');
      const messages: CouncilMessage[] = [
        { id: 'msg-1', role: 'human', content: 'Question', timestamp: Date.now() },
      ];

      await tieredWorker.respond(messages, 'analyst', undefined, 'high');
      await tieredWorker.respond(messages, 'analyst', undefined, 'high');
      await tieredWorker.respond(messages, 'analyst', undefined, 'low');

      const stats = tieredWorker.getStats();
      expect(stats.modelUsage['claude-opus-4-6']).toBeDefined();
      expect(stats.modelUsage['claude-opus-4-6'].calls).toBe(2);
      expect(stats.modelUsage['claude-opus-4-6'].inputTokens).toBe(400);
      expect(stats.modelUsage['claude-opus-4-6'].outputTokens).toBe(160);
      expect(stats.modelUsage['claude-haiku-3-5']).toBeDefined();
      expect(stats.modelUsage['claude-haiku-3-5'].calls).toBe(1);
    });
  });
});
