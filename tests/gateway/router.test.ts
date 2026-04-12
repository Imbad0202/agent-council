import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GatewayRouter } from '../../src/gateway/router.js';
import type { AgentWorker } from '../../src/worker/agent-worker.js';
import type { CouncilConfig, CouncilMessage, ProviderResponse } from '../../src/types.js';

const mockWorkerResponse: ProviderResponse = {
  content: 'I think we should consider the trade-offs.',
  tokensUsed: { input: 100, output: 50 },
};

function createMockWorker(id: string, name: string): AgentWorker {
  return {
    id,
    name,
    respond: vi.fn().mockResolvedValue(mockWorkerResponse),
    getStats: vi.fn().mockReturnValue({ responseCount: 0, disagreementRate: 0, averageLength: 0, skipCount: 0 }),
  } as unknown as AgentWorker;
}

const councilConfig: CouncilConfig = {
  gateway: {
    thinkingWindowMs: 10,
    randomDelayMs: [0, 10],
    maxInterAgentRounds: 3,
    contextWindowTurns: 10,
    sessionMaxTurns: 20,
  },
  antiSycophancy: {
    disagreementThreshold: 0.2,
    consecutiveLowRounds: 3,
    challengeAngles: ['cost', 'risk'],
  },
  roles: {
    default2Agents: ['advocate', 'critic'],
    topicOverrides: {},
  },
};

describe('GatewayRouter', () => {
  let router: GatewayRouter;
  let workers: AgentWorker[];
  let sentMessages: Array<{ agentId: string; content: string }>;

  beforeEach(() => {
    workers = [createMockWorker('huahua', '花花'), createMockWorker('binbin', '賓賓')];
    sentMessages = [];
    router = new GatewayRouter(workers, councilConfig, async (agentId, content) => {
      sentMessages.push({ agentId, content });
    });
  });

  it('processes a human message and gets responses from all workers', async () => {
    await router.handleHumanMessage({
      id: 'msg-1',
      role: 'human',
      content: 'What architecture should we use?',
      timestamp: Date.now(),
    });

    expect(workers[0].respond).toHaveBeenCalled();
    expect(workers[1].respond).toHaveBeenCalled();
    expect(sentMessages).toHaveLength(2);
  });

  it('assigns roles to workers', async () => {
    await router.handleHumanMessage({
      id: 'msg-1',
      role: 'human',
      content: 'Review this code',
      timestamp: Date.now(),
    });

    const call0 = vi.mocked(workers[0].respond).mock.calls[0];
    const call1 = vi.mocked(workers[1].respond).mock.calls[0];
    expect(call0[1]).toBeDefined();
    expect(call1[1]).toBeDefined();
  });

  it('maintains conversation history', async () => {
    await router.handleHumanMessage({
      id: 'msg-1',
      role: 'human',
      content: 'First question',
      timestamp: Date.now(),
    });

    await router.handleHumanMessage({
      id: 'msg-2',
      role: 'human',
      content: 'Follow up',
      timestamp: Date.now() + 1000,
    });

    const call = vi.mocked(workers[0].respond).mock.calls[1];
    const messages = call[0] as CouncilMessage[];
    expect(messages.length).toBeGreaterThan(1);
  });
});
