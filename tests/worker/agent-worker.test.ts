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
});
