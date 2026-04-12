import { describe, it, expect } from 'vitest';
import { assignRoles } from '../../src/council/role-assigner.js';
import type { AgentRole, CouncilConfig } from '../../src/types.js';

const config: CouncilConfig = {
  gateway: {
    thinkingWindowMs: 5000,
    randomDelayMs: [1000, 3000],
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
    topicOverrides: {
      code: ['author', 'reviewer'],
      strategy: ['advocate', 'critic'],
    },
  },
};

describe('assignRoles', () => {
  it('assigns default roles for 2 agents', () => {
    const roles = assignRoles(['huahua', 'binbin'], 'What do you think?', config);
    expect(Object.keys(roles)).toHaveLength(2);
    const assigned = Object.values(roles);
    expect(assigned).toContain('advocate');
    expect(assigned).toContain('critic');
  });

  it('uses topic overrides for code-related messages', () => {
    const roles = assignRoles(['huahua', 'binbin'], 'Review this code implementation', config);
    const assigned = Object.values(roles);
    expect(assigned).toContain('author');
    expect(assigned).toContain('reviewer');
  });

  it('uses topic overrides for strategy-related messages', () => {
    const roles = assignRoles(['huahua', 'binbin'], 'What strategy should we use?', config);
    const assigned = Object.values(roles);
    expect(assigned).toContain('advocate');
    expect(assigned).toContain('critic');
  });

  it('always assigns at least one critic-type role', () => {
    const roles = assignRoles(['huahua', 'binbin'], 'Hello world', config);
    const assigned = Object.values(roles);
    const hasCritic = assigned.some((r) => r === 'critic' || r === 'reviewer');
    expect(hasCritic).toBe(true);
  });
});
