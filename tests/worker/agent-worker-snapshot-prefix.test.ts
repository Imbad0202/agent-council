import { describe, it, expect, vi } from 'vitest';
import { AgentWorker } from '../../src/worker/agent-worker.js';
import type {
  AgentConfig,
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
  const calls: ProviderMessage[][] = [];
  const provider: LLMProvider = {
    name: 'fake',
    chat: vi.fn(async (messages: ProviderMessage[]) => {
      calls.push(messages);
      return {
        content: 'ok',
        tokensUsed: { input: 1, output: 1 },
      } as ProviderResponse;
    }),
    summarize: vi.fn(),
    estimateTokens: vi.fn().mockReturnValue(0),
  };
  return { provider, calls };
}

describe('AgentWorker.respond snapshotPrefix', () => {
  it('prepends a synthetic user message when snapshotPrefix is provided', async () => {
    const { provider, calls } = makeProvider();
    const worker = new AgentWorker(agentConfig, provider, '/tmp/no-memory');

    await worker.respond(
      [{ id: 'm1', role: 'human', content: 'hello', timestamp: 1 }],
      'generator',
      undefined,
      undefined,
      false,
      'SUMMARY: prior segment decisions',
    );

    expect(provider.chat).toHaveBeenCalledTimes(1);
    const msgs = calls[0];
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toContain('SUMMARY: prior segment decisions');
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toBe('hello');
  });

  it('does nothing when snapshotPrefix is undefined', async () => {
    const { provider, calls } = makeProvider();
    const worker = new AgentWorker(agentConfig, provider, '/tmp/no-memory');

    await worker.respond(
      [{ id: 'm1', role: 'human', content: 'hello', timestamp: 1 }],
      'generator',
    );

    expect(calls[0]).toHaveLength(1);
    expect(calls[0][0].content).toBe('hello');
  });

  it('does nothing when snapshotPrefix is empty string', async () => {
    const { provider, calls } = makeProvider();
    const worker = new AgentWorker(agentConfig, provider, '/tmp/no-memory');

    await worker.respond(
      [{ id: 'm1', role: 'human', content: 'hello', timestamp: 1 }],
      'generator',
      undefined,
      undefined,
      false,
      '',
    );

    expect(calls[0]).toHaveLength(1);
  });
});
