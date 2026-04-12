export const TOPIC_KEYWORDS: Record<string, string[]> = {
  code: ['code', 'implement', 'function', 'bug', 'refactor', 'review', 'pr', 'commit', 'test', 'debug', 'api'],
  strategy: ['strategy', 'plan', 'approach', 'decide', 'choose', 'direction', 'roadmap', 'priority'],
  research: ['research', 'paper', 'study', 'evidence', 'data', 'analysis', 'literature'],
  architecture: ['architecture', 'design', 'pattern', 'structure', 'module', 'component', 'system'],
  risk: ['risk', 'security', 'vulnerability', 'threat', 'audit', 'compliance'],
  testing: ['test', 'qa', 'quality', 'coverage', 'regression', 'integration'],
};

export function detectTopics(message: string): string[] {
  const lower = message.toLowerCase();
  const matched: string[] = [];
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      matched.push(topic);
    }
  }
  return matched;
}

export function detectBestTopic(message: string): string | null {
  const lower = message.toLowerCase();
  let bestTopic: string | null = null;
  let bestCount = 0;
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    const count = keywords.filter((kw) => lower.includes(kw)).length;
    if (count > bestCount) {
      bestCount = count;
      bestTopic = topic;
    }
  }
  return bestCount > 0 ? bestTopic : null;
}
