import { vi } from 'vitest';
import type { AgentWorker } from '../../src/worker/agent-worker.js';
import type { CouncilConfig, CouncilMessage, ProviderResponse } from '../../src/types.js';

export function makeWorker(id: string, name: string): AgentWorker {
  return {
    id,
    name,
    respond: vi.fn<[], Promise<ProviderResponse>>().mockResolvedValue({
      content: `Response from ${id}`,
      confidence: 0.8,
      references: [],
      tokensUsed: { input: 100, output: 50 },
    }),
  } as unknown as AgentWorker;
}

export const minConfig: CouncilConfig = {
  gateway: {
    thinkingWindowMs: 0,
    randomDelayMs: [0, 0],
    maxInterAgentRounds: 3,
    contextWindowTurns: 10,
    sessionMaxTurns: 20,
  },
  antiSycophancy: {
    disagreementThreshold: 0.2,
    consecutiveLowRounds: 3,
    challengeAngles: ['cost', 'risk', 'alternatives'],
  },
  roles: {
    default2Agents: ['advocate', 'critic'],
    topicOverrides: {},
  },
} as unknown as CouncilConfig;

export function makeMessage(content: string, threadId = 1): CouncilMessage {
  return {
    id: `msg-${Date.now()}`,
    role: 'human',
    content,
    timestamp: Date.now(),
    threadId,
  };
}
