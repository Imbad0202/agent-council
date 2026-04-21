import {
  COLLABORATION_DEPTH_AXES,
  clamp01,
  levelForScore,
  type CollaborationDepthAxis,
  type CollaborationDepthLevel,
} from '../shared/collaboration-depth-rubric.js';
import type { HumanCritiqueStance } from './human-critique.js';

export type { HumanCritiqueStance };

export interface HumanCritiqueRecord {
  stance: HumanCritiqueStance;
  acknowledgedByNextAgent: boolean;
  introducedNovelAngle: boolean;
}

export interface DepthSessionInput {
  agentTurns: number;
  humanCritiques: HumanCritiqueRecord[];
  stanceShiftsInducedByHuman: number;
}

export interface DepthScoreResult {
  level: CollaborationDepthLevel;
  score: number;
  axisBreakdown: Record<CollaborationDepthAxis, number>;
}

// Equal-weighted across four axes so no single axis dominates. Wang & Zhang
// don't prescribe weights; equal weighting is a defensible prior and lets
// per-axis breakdown tell the richer story.
const AXIS_WEIGHTS: Record<CollaborationDepthAxis, number> = {
  interruptionRate: 0.25,
  acceptanceRatio: 0.25,
  stanceShiftInduced: 0.25,
  divergenceIntroduced: 0.25,
};

export function scoreSession(input: DepthSessionInput): DepthScoreResult {
  const { agentTurns, humanCritiques, stanceShiftsInducedByHuman } = input;
  const critiqueCount = humanCritiques.length;

  const interruptionRate =
    agentTurns > 0 ? clamp01(critiqueCount / agentTurns) : 0;

  const acknowledged = humanCritiques.filter((c) => c.acknowledgedByNextAgent).length;
  const acceptanceRatio = critiqueCount > 0 ? acknowledged / critiqueCount : 0;

  // A stance shift per critique caps at 1. If user drove more shifts than
  // critiques (implausible but possible if multiple agents shift from one
  // critique), clamp.
  const stanceShiftInduced =
    critiqueCount > 0 ? clamp01(stanceShiftsInducedByHuman / critiqueCount) : 0;

  const novel = humanCritiques.filter((c) => c.introducedNovelAngle).length;
  const divergenceIntroduced = critiqueCount > 0 ? novel / critiqueCount : 0;

  const axisBreakdown: Record<CollaborationDepthAxis, number> = {
    interruptionRate,
    acceptanceRatio,
    stanceShiftInduced,
    divergenceIntroduced,
  };

  let score = 0;
  for (const axis of COLLABORATION_DEPTH_AXES) {
    score += axisBreakdown[axis] * AXIS_WEIGHTS[axis];
  }
  score = clamp01(score);

  return { level: levelForScore(score), score, axisBreakdown };
}
