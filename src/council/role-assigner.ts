import type { AgentRole, CouncilConfig, PatternRecord } from '../types.js';
import { detectBestTopic } from './topics.js';

const ADVERSARIAL_ROLES: AgentRole[] = [
  'biased-prover',
  'deceptive-prover',
  'calibrated-prover',
];

export function assignRoles(
  agentIds: string[],
  message: string,
  config: CouncilConfig,
  patterns?: PatternRecord[],
  options?: { allowSneaky?: boolean; allowAdversarial?: boolean },
): Record<string, AgentRole> {
  const topic = detectBestTopic(message);
  let roleList: AgentRole[];

  if (topic && config.roles.topicOverrides[topic]) {
    roleList = [...config.roles.topicOverrides[topic]];
  } else {
    roleList = [...config.roles.default2Agents];
  }

  if (roleList.includes('sneaky-prover') && options?.allowSneaky !== true) {
    throw new Error(
      'sneaky-prover role assigned but allowSneaky=false — this role is opt-in via /stresstest only',
    );
  }

  for (const role of ADVERSARIAL_ROLES) {
    if (roleList.includes(role) && options?.allowAdversarial !== true) {
      throw new Error(
        `${role} role assigned but allowAdversarial=false — PVG adversarial roles are opt-in only`,
      );
    }
  }

  while (roleList.length < agentIds.length) {
    roleList.push('analyst');
  }

  // Pattern-informed assignment: if an agent tends toward one behavior, assign opposite role
  if (patterns && patterns.length > 0 && roleList.length >= 2) {
    const relevantPatterns = patterns.filter((p) => !topic || p.topic === topic);

    if (relevantPatterns.length > 0) {
      const patternAgent = relevantPatterns[0].agentId;
      const behavior = relevantPatterns[0].behavior.toLowerCase();
      const isConservative = behavior.includes('conservative') || behavior.includes('cautious');

      if (isConservative && agentIds.includes(patternAgent) && agentIds.length >= 2) {
        const assignments: Record<string, AgentRole> = {};
        assignments[patternAgent] = roleList.find((r) => r === 'advocate' || r === 'author') ?? roleList[0];
        const otherAgent = agentIds.find((id) => id !== patternAgent);
        if (!otherAgent) return assignments; // shouldn't happen with length >= 2 guard
        assignments[otherAgent] = roleList.find((r) => r === 'critic' || r === 'reviewer') ?? roleList[1];
        return assignments;
      }
    }
  }

  const shuffledAgents = [...agentIds].sort(() => Math.random() - 0.5);

  const assignments: Record<string, AgentRole> = {};
  shuffledAgents.forEach((agentId, i) => {
    assignments[agentId] = roleList[i];
  });

  return assignments;
}
