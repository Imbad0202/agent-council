// Collaboration depth rubric — grounded in Wang & Zhang 2026 dual cognitive
// pathways paradox. Lives in src/shared/ so ARS can later import the same
// definitions (planned: extract to shared/collaboration_depth_rubric.md +
// mirrored TS module).

export const COLLABORATION_DEPTH_LEVELS = [
  'surface',
  'moderate',
  'deep',
  'transformative',
] as const;

export type CollaborationDepthLevel = (typeof COLLABORATION_DEPTH_LEVELS)[number];

export const COLLABORATION_DEPTH_AXES = [
  'interruptionRate',
  'acceptanceRatio',
  'stanceShiftInduced',
  'divergenceIntroduced',
] as const;

export type CollaborationDepthAxis = (typeof COLLABORATION_DEPTH_AXES)[number];

export interface DepthRange {
  min: number;
  max: number;
}

// Contiguous ranges on [0, 1]. Lower bound inclusive, upper bound exclusive,
// except the final level which is inclusive on both ends.
export const COLLABORATION_DEPTH_THRESHOLDS: Record<CollaborationDepthLevel, DepthRange> = {
  surface: { min: 0, max: 0.25 },
  moderate: { min: 0.25, max: 0.5 },
  deep: { min: 0.5, max: 0.75 },
  transformative: { min: 0.75, max: 1 },
};

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function levelForScore(score: number): CollaborationDepthLevel {
  const clamped = clamp01(score);
  for (const level of COLLABORATION_DEPTH_LEVELS) {
    const { min, max } = COLLABORATION_DEPTH_THRESHOLDS[level];
    if (level === 'transformative' ? clamped >= min : clamped >= min && clamped < max) {
      return level;
    }
  }
  return 'surface';
}
