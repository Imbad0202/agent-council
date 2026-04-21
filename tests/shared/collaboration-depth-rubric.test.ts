import { describe, it, expect } from 'vitest';
import {
  COLLABORATION_DEPTH_LEVELS,
  COLLABORATION_DEPTH_AXES,
  COLLABORATION_DEPTH_THRESHOLDS,
  type CollaborationDepthLevel,
} from '../../src/shared/collaboration-depth-rubric.js';

describe('CollaborationDepthRubric', () => {
  it('defines four levels in ascending depth order', () => {
    expect(COLLABORATION_DEPTH_LEVELS).toEqual([
      'surface',
      'moderate',
      'deep',
      'transformative',
    ]);
  });

  it('defines four scoring axes', () => {
    // Axes derived from Wang & Zhang 2026 dual-pathway model:
    //   interruptionRate (H2b — user push-back frequency)
    //   acceptanceRatio  (partnership quality, not cognitive offloading)
    //   stanceShiftInduced (transformative learning signal)
    //   divergenceIntroduced (user added novel angle, not just yes/no)
    expect(COLLABORATION_DEPTH_AXES).toEqual([
      'interruptionRate',
      'acceptanceRatio',
      'stanceShiftInduced',
      'divergenceIntroduced',
    ]);
  });

  it('thresholds cover 0..1 range without gaps or overlap', () => {
    const entries = COLLABORATION_DEPTH_LEVELS.map((lvl) => ({
      level: lvl,
      range: COLLABORATION_DEPTH_THRESHOLDS[lvl],
    }));
    // lower bounds strictly ascending
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].range.min).toBeGreaterThanOrEqual(entries[i - 1].range.max);
    }
    // surface starts at 0, transformative ends at 1 (inclusive)
    expect(entries[0].range.min).toBe(0);
    expect(entries[entries.length - 1].range.max).toBe(1);
    // every range is well-formed
    for (const e of entries) {
      expect(e.range.max).toBeGreaterThan(e.range.min);
    }
  });

  it('level type is the union of the level constant array', () => {
    // compile-time guard: assign each literal, no runtime assertion needed
    const s: CollaborationDepthLevel = 'surface';
    const m: CollaborationDepthLevel = 'moderate';
    const d: CollaborationDepthLevel = 'deep';
    const t: CollaborationDepthLevel = 'transformative';
    expect([s, m, d, t]).toHaveLength(4);
  });
});
