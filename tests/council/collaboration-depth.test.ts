import { describe, it, expect } from 'vitest';
import { scoreSession, type DepthSessionInput } from '../../src/council/collaboration-depth.js';
import { COLLABORATION_DEPTH_AXES } from '../../src/shared/collaboration-depth-rubric.js';

function baseSession(overrides: Partial<DepthSessionInput> = {}): DepthSessionInput {
  return {
    agentTurns: 0,
    humanCritiques: [],
    stanceShiftsInducedByHuman: 0,
    ...overrides,
  };
}

describe('scoreSession', () => {
  it('zero-critique session scores as surface', () => {
    const result = scoreSession(baseSession({ agentTurns: 6 }));
    expect(result.level).toBe('surface');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThan(0.25);
    // All axes reported
    for (const axis of COLLABORATION_DEPTH_AXES) {
      expect(result.axisBreakdown[axis]).toBeGreaterThanOrEqual(0);
      expect(result.axisBreakdown[axis]).toBeLessThanOrEqual(1);
    }
    expect(result.axisBreakdown.interruptionRate).toBe(0);
  });

  it('surface-only: one critique in a six-turn session, no acceptance/shift', () => {
    const result = scoreSession(
      baseSession({
        agentTurns: 6,
        humanCritiques: [
          { stance: 'question', acknowledgedByNextAgent: false, introducedNovelAngle: false },
        ],
      }),
    );
    expect(result.level).toBe('surface');
    expect(result.axisBreakdown.interruptionRate).toBeCloseTo(1 / 6, 5);
    expect(result.axisBreakdown.acceptanceRatio).toBe(0);
    expect(result.axisBreakdown.divergenceIntroduced).toBe(0);
  });

  it('moderate: interrupts ~half the turns, half acknowledged, one novel angle', () => {
    const result = scoreSession(
      baseSession({
        agentTurns: 4,
        humanCritiques: [
          { stance: 'challenge', acknowledgedByNextAgent: true, introducedNovelAngle: false },
          { stance: 'question', acknowledgedByNextAgent: false, introducedNovelAngle: true },
        ],
        stanceShiftsInducedByHuman: 0,
      }),
    );
    expect(result.level).toBe('moderate');
    expect(result.axisBreakdown.interruptionRate).toBeCloseTo(0.5, 5);
    expect(result.axisBreakdown.acceptanceRatio).toBeCloseTo(0.5, 5);
    expect(result.axisBreakdown.divergenceIntroduced).toBeCloseTo(0.5, 5);
  });

  it('deep-transformative: frequent critique, high acceptance, stance shifts and novel angles', () => {
    const result = scoreSession(
      baseSession({
        agentTurns: 4,
        humanCritiques: [
          { stance: 'challenge', acknowledgedByNextAgent: true, introducedNovelAngle: true },
          { stance: 'addPremise', acknowledgedByNextAgent: true, introducedNovelAngle: true },
          { stance: 'challenge', acknowledgedByNextAgent: true, introducedNovelAngle: true },
          { stance: 'addPremise', acknowledgedByNextAgent: true, introducedNovelAngle: true },
        ],
        stanceShiftsInducedByHuman: 2,
      }),
    );
    expect(['deep', 'transformative']).toContain(result.level);
    expect(result.axisBreakdown.acceptanceRatio).toBe(1);
    expect(result.axisBreakdown.stanceShiftInduced).toBeGreaterThan(0);
    expect(result.axisBreakdown.divergenceIntroduced).toBe(1);
  });

  it('empty agentTurns with no critique yields zero interruptionRate, not NaN', () => {
    const result = scoreSession(baseSession({ agentTurns: 0 }));
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.axisBreakdown.interruptionRate).toBe(0);
  });

  it('interruptionRate clamps at 1 when critiques outnumber turns', () => {
    const result = scoreSession(
      baseSession({
        agentTurns: 1,
        humanCritiques: [
          { stance: 'challenge', acknowledgedByNextAgent: true, introducedNovelAngle: true },
          { stance: 'challenge', acknowledgedByNextAgent: true, introducedNovelAngle: true },
          { stance: 'challenge', acknowledgedByNextAgent: true, introducedNovelAngle: true },
        ],
      }),
    );
    expect(result.axisBreakdown.interruptionRate).toBe(1);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});
