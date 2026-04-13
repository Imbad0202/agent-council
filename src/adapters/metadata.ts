import type { AgentConfig, AgentRole, ResponseClassification } from '../types.js';
import type { RichMetadata } from './types.js';

export function deriveEmotion(classification?: ResponseClassification): RichMetadata['emotion'] {
  switch (classification) {
    case 'opposition': return 'assertive';
    case 'conditional': return 'thoughtful';
    case 'agreement': return 'neutral';
    default: return 'neutral';
  }
}

export function deriveStanceShift(
  current?: ResponseClassification,
  previous?: ResponseClassification,
): RichMetadata['stanceShift'] {
  if (!previous || !current || current === previous) return 'unchanged';
  if (previous === 'opposition' && current === 'agreement') return 'softened';
  if (previous === 'agreement' && current === 'opposition') return 'hardened';
  return 'unchanged';
}

export function buildRichMetadata(
  agentId: string,
  agents: AgentConfig[],
  classification?: ResponseClassification,
  previousClassification?: ResponseClassification,
  role?: AgentRole,
): RichMetadata {
  const agent = agents.find((a) => a.id === agentId);
  return {
    agentName: agent?.name ?? agentId,
    role,
    emotion: deriveEmotion(classification),
    stanceShift: deriveStanceShift(classification, previousClassification),
    isSystem: agentId === 'system',
  };
}
