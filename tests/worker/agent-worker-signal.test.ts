import { describe, it, expect, vi } from 'vitest';
import { AgentWorker } from '../../src/worker/agent-worker.js';
import type { AgentConfig, ChatOptions, ProviderMessage } from '../../src/types.js';

const cfg: AgentConfig = {
  id: 'test-agent',
  name: 'Test Agent',
  provider: 'claude',
  model: 'claude-sonnet-4-6',
  memoryDir: 'test-agent/global',
  personality: 'You are a test agent.',
  cacheSystemPrompt: false,
};

function makeProvider() {
  const calls: Array<{ msgs: ProviderMessage[]; opts: ChatOptions }> = [];
  const provider = {
    name: 'claude' as const,
    chat: vi.fn(async (msgs: ProviderMessage[], opts: ChatOptions) => {
      calls.push({ msgs, opts });
      return { content: 'ok', model: 'claude-sonnet-4-6', tokensUsed: { input: 1, output: 1 } };
    }),
    summarize: vi.fn(),
    estimateTokens: vi.fn().mockReturnValue(0),
  };
  return { provider, calls };
}

describe('AgentWorker.respond signal (v0.5.3 §5.1 site 1)', () => {
  it('passes signal to provider.chat options when supplied', async () => {
    const { provider, calls } = makeProvider();
    const worker = new AgentWorker(cfg, provider as never, '/tmp/no-memory');
    const ctrl = new AbortController();

    await worker.respond(
      [{ id: 'm1', role: 'human', content: 'hi', timestamp: 1 }],
      'generator',
      undefined,  // challengePrompt
      undefined,  // complexity
      false,      // rotationMode
      undefined,  // snapshotPrefix
      ctrl.signal, // signal (7th positional)
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].opts.signal).toBe(ctrl.signal);
  });

  it('omits signal from chat options when not supplied (back-compat)', async () => {
    const { provider, calls } = makeProvider();
    const worker = new AgentWorker(cfg, provider as never, '/tmp/no-memory');

    await worker.respond(
      [{ id: 'm1', role: 'human', content: 'hi', timestamp: 1 }],
      'generator',
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].opts.signal).toBeUndefined();
  });
});
