import type { CouncilMessage } from '../types.js';

export type HumanCritiqueStance = 'question' | 'challenge' | 'addPremise';

export interface MakeHumanCritiqueInput {
  content: string;
  stance: HumanCritiqueStance;
  targetAgent?: string;
  threadId?: number;
  timestamp?: number;
  id?: string;
}

let critiqueSeq = 0;

export function makeHumanCritique(input: MakeHumanCritiqueInput): CouncilMessage {
  return {
    id: input.id ?? `critique-${Date.now()}-${++critiqueSeq}`,
    role: 'human-critique',
    content: input.content,
    timestamp: input.timestamp ?? Date.now(),
    threadId: input.threadId,
    critiqueStance: input.stance,
    critiqueTarget: input.targetAgent,
  };
}

export function isHumanCritique(msg: CouncilMessage): boolean {
  return msg.role === 'human-critique';
}
