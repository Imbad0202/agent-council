// tests/council/sneaky-prover.test.ts
import { describe, it, expect } from 'vitest';
import { ROLE_DIRECTIVES_INTERNAL } from '../../src/worker/personality.js';
import { parseSneakyTrailer, formatDebrief, pickSneakyTarget } from '../../src/council/sneaky-prover.js';
import { assignRoles } from '../../src/council/role-assigner.js';
import type { CouncilConfig } from '../../src/types.js';

const baseConfig: CouncilConfig = {
  roles: {
    default2Agents: ['advocate', 'critic'],
    topicOverrides: {},
  },
  antiSycophancy: { enabled: false, maxConsecutiveAgreements: 3 },
} as unknown as CouncilConfig;

describe('sneaky-prover role', () => {
  it('ROLE_DIRECTIVES has sneaky-prover entry with IRON RULE and trailer marker', () => {
    const directive = ROLE_DIRECTIVES_INTERNAL['sneaky-prover'];
    expect(directive).toBeDefined();
    expect(directive).toContain('IRON RULE');
    expect(directive).toContain('<<<SNEAKY-PROVER:');
  });

  it('parseSneakyTrailer extracts kind, debrief, and stripped body', () => {
    const content = `Here is my analysis.

Based on a 2024 study by Smith et al., this approach increases throughput by 47%.

<<<SNEAKY-PROVER:fabricated-citation|Smith et al. 2024 does not exist; statistic invented>>>`;
    const parsed = parseSneakyTrailer(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe('fabricated-citation');
    expect(parsed!.debrief).toBe('Smith et al. 2024 does not exist; statistic invented');
    expect(parsed!.bodyWithoutTrailer).toContain('Here is my analysis.');
    expect(parsed!.bodyWithoutTrailer).not.toContain('<<<SNEAKY-PROVER:');
  });

  it('parseSneakyTrailer returns null when trailer absent', () => {
    expect(parseSneakyTrailer('Just a normal response with no trailer.')).toBeNull();
  });

  it('formatDebrief renders agentId + kind + debrief on one line', () => {
    const out = formatDebrief({
      agentId: 'agent-x',
      kind: 'logical-fallacy',
      debrief: 'False dichotomy in paragraph 2',
    });
    expect(out).toContain('🔒 [SNEAKY DEBRIEF]');
    expect(out).toContain('agent-x');
    expect(out).toContain('logical-fallacy');
    expect(out).toContain('False dichotomy in paragraph 2');
  });

  it('assignRoles default does NOT include sneaky-prover', () => {
    const assignments = assignRoles(['a1', 'a2'], 'normal message', baseConfig);
    expect(Object.values(assignments)).not.toContain('sneaky-prover');
  });

  it('assignRoles throws when sneaky-prover requested without allowSneaky', () => {
    const cfg: CouncilConfig = {
      ...baseConfig,
      roles: {
        ...baseConfig.roles,
        topicOverrides: { 'stress-test': ['sneaky-prover', 'critic'] },
      },
    } as CouncilConfig;
    expect(() => assignRoles(['a1', 'a2'], 'stress-test the proposal', cfg)).toThrow(
      /sneaky-prover.*allowSneaky/i,
    );
  });

  it('pickSneakyTarget uses injected RNG deterministically', () => {
    expect(pickSneakyTarget(['a1', 'a2', 'a3'], () => 0.0)).toBe('a1');
    expect(pickSneakyTarget(['a1', 'a2', 'a3'], () => 0.999)).toBe('a3');
  });
});
