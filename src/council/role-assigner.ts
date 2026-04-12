import type { AgentRole, CouncilConfig, PatternRecord } from '../types.js';

const TOPIC_KEYWORDS: Record<string, string[]> = {
  code: ['code', 'implement', 'function', 'bug', 'refactor', 'review', 'PR', 'commit', 'test', 'debug', 'API'],
  strategy: ['strategy', 'plan', 'approach', 'decide', 'choose', 'direction', 'roadmap', 'priority'],
  research: ['research', 'paper', 'study', 'evidence', 'data', 'analysis', 'literature'],
};

function detectTopic(message: string): string | null {
  const lower = message.toLowerCase();
  let bestTopic: string | null = null;
  let bestCount = 0;

  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    const count = keywords.filter((kw) => lower.includes(kw.toLowerCase())).length;
    if (count > bestCount) {
      bestCount = count;
      bestTopic = topic;
    }
  }

  return bestCount > 0 ? bestTopic : null;
}

export function assignRoles(
  agentIds: string[],
  message: string,
  config: CouncilConfig,
  patterns?: PatternRecord[],
): Record<string, AgentRole> {
  const topic = detectTopic(message);
  let roleList: AgentRole[];

  if (topic && config.roles.topicOverrides[topic]) {
    roleList = [...config.roles.topicOverrides[topic]];
  } else {
    roleList = [...config.roles.default2Agents];
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

      if (isConservative && agentIds.includes(patternAgent)) {
        const assignments: Record<string, AgentRole> = {};
        assignments[patternAgent] = roleList.find((r) => r === 'advocate' || r === 'author') ?? roleList[0];
        const otherAgent = agentIds.find((id) => id !== patternAgent)!;
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
