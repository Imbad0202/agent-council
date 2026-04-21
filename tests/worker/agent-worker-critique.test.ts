import { describe, it, expect, vi } from 'vitest';
import { AgentWorker } from '../../src/worker/agent-worker.js';
import { makeHumanCritique } from '../../src/council/human-critique.js';
import type { AgentConfig, LLMProvider, CouncilMessage, ProviderResponse } from '../../src/types.js';

const agentConfig: AgentConfig = {
  id: 'huahua',
  name: '花花',
  provider: 'claude',
  model: 'claude-opus-4-7',
  memoryDir: '花花/global',
  personality: 'You are 花花.',
};

function mockProvider() {
  return {
    name: 'mock',
    chat: vi.fn().mockResolvedValue({
      content: 'ok',
      tokensUsed: { input: 1, output: 1 },
    } as ProviderResponse),
    summarize: vi.fn().mockResolvedValue('s'),
    estimateTokens: vi.fn().mockReturnValue(0),
  } satisfies LLMProvider;
}

describe('AgentWorker — human-critique message serialization', () => {
  it('labels human-critique turns with [Human] instead of [undefined]', async () => {
    const provider = mockProvider();
    const worker = new AgentWorker(agentConfig, provider, '/tmp/no-memory');

    const critique = makeHumanCritique({
      content: 'You ignored the cost axis.',
      stance: 'challenge',
      targetAgent: 'huahua',
    });
    const messages: CouncilMessage[] = [
      { id: 'msg-1', role: 'human', content: 'topic', timestamp: 1 },
      critique,
    ];

    await worker.respond(messages, 'critic');

    const passedMessages = provider.chat.mock.calls[0][0] as { role: string; content: string }[];
    const critiqueEntry = passedMessages.find((m) => m.content.includes('ignored the cost axis'));
    expect(critiqueEntry).toBeDefined();
    expect(critiqueEntry!.content).not.toContain('[undefined]');
    expect(critiqueEntry!.content).toContain('[Human');
  });
});
