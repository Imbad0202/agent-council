import { describe, it, expect, vi } from 'vitest';
import { AgentWorker } from '../../src/worker/agent-worker.js';
import type {
  AgentConfig,
  ChatOptions,
  LLMProvider,
  ProviderMessage,
  ProviderResponse,
} from '../../src/types.js';

const agentConfig: AgentConfig = {
  id: 'huahua',
  name: '花花',
  provider: 'claude',
  model: 'claude-opus-4-7',
  memoryDir: '花花/global',
  personality: 'You are 花花.',
};

function makeProvider() {
  const optionsLog: ChatOptions[] = [];
  const provider: LLMProvider = {
    name: 'fake',
    chat: vi.fn(async (_msgs: ProviderMessage[], opts: ChatOptions) => {
      optionsLog.push(opts);
      return {
        content: 'ok',
        tokensUsed: { input: 1, output: 1 },
      } as ProviderResponse;
    }),
    summarize: vi.fn(),
    estimateTokens: vi.fn().mockReturnValue(0),
  };
  return { provider, optionsLog };
}

describe('AgentWorker.respondDeterministic', () => {
  it('passes temperature: 0 to the provider', async () => {
    const { provider, optionsLog } = makeProvider();
    const worker = new AgentWorker(agentConfig, provider, '/tmp/no-memory');

    await worker.respondDeterministic(
      [{ id: 'm1', role: 'human', content: 'summarise', timestamp: 1 }],
      'synthesizer',
    );

    expect(optionsLog[0].temperature).toBe(0);
  });

  it('does NOT set thinking (temp=0 is incompatible with Anthropic thinking)', async () => {
    const { provider, optionsLog } = makeProvider();
    const worker = new AgentWorker(agentConfig, provider, '/tmp/no-memory');

    await worker.respondDeterministic(
      [{ id: 'm1', role: 'human', content: 'summarise', timestamp: 1 }],
      'synthesizer',
    );

    expect(optionsLog[0].thinking).toBeUndefined();
  });

  it('resolves a model from config', async () => {
    const { provider, optionsLog } = makeProvider();
    const worker = new AgentWorker(agentConfig, provider, '/tmp/no-memory');

    await worker.respondDeterministic(
      [{ id: 'm1', role: 'human', content: 'summarise', timestamp: 1 }],
      'synthesizer',
    );

    expect(optionsLog[0].model).toBe('claude-opus-4-7');
  });

  it('passes system prompt', async () => {
    const { provider, optionsLog } = makeProvider();
    const worker = new AgentWorker(agentConfig, provider, '/tmp/no-memory');

    await worker.respondDeterministic(
      [{ id: 'm1', role: 'human', content: 'summarise', timestamp: 1 }],
      'synthesizer',
    );

    expect(optionsLog[0].systemPrompt).toContain('花花');
  });

  it('updates stats.modelUsage (bookkeeping parity with respond)', async () => {
    const { provider } = makeProvider();
    const worker = new AgentWorker(agentConfig, provider, '/tmp/no-memory');

    await worker.respondDeterministic(
      [{ id: 'm1', role: 'human', content: 'summarise', timestamp: 1 }],
      'synthesizer',
    );

    const stats = worker.getStats();
    expect(stats.responseCount).toBe(1);
    expect(stats.modelUsage['claude-opus-4-7']).toEqual({
      calls: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
  });

  it('sets modelUsed on returned response', async () => {
    const { provider } = makeProvider();
    const worker = new AgentWorker(agentConfig, provider, '/tmp/no-memory');

    const res = await worker.respondDeterministic(
      [{ id: 'm1', role: 'human', content: 'summarise', timestamp: 1 }],
      'synthesizer',
    );

    expect(res.modelUsed).toBe('claude-opus-4-7');
  });
});
