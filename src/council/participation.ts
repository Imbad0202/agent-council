import type { AgentConfig, ParticipationConfig } from '../types.js';

// Reuse topic keywords from role-assigner (or import a shared list)
const TOPIC_KEYWORDS: Record<string, string[]> = {
  code: ['code', 'implement', 'function', 'bug', 'refactor', 'review', 'PR', 'commit', 'test', 'debug', 'API'],
  strategy: ['strategy', 'plan', 'approach', 'decide', 'choose', 'direction', 'roadmap', 'priority'],
  research: ['research', 'paper', 'study', 'evidence', 'data', 'analysis', 'literature'],
  architecture: ['architecture', 'design', 'pattern', 'structure', 'module', 'component', 'system'],
  risk: ['risk', 'security', 'vulnerability', 'threat', 'audit', 'compliance'],
  testing: ['test', 'qa', 'quality', 'coverage', 'regression', 'integration'],
};

interface ParticipationChange {
  joining: string[];    // agent IDs joining
  leaving: string[];    // agent IDs leaving
}

export class ParticipationManager {
  private config: ParticipationConfig;
  private allAgents: AgentConfig[];

  constructor(config: ParticipationConfig, agents: AgentConfig[]) {
    this.config = config;
    this.allAgents = agents;
  }

  /**
   * Select which agents should participate in this turn.
   */
  selectParticipants(message: string): string[] {
    const detectedTopics = this.detectTopics(message);

    // Score each agent by topic match
    const scored = this.allAgents.map((agent) => {
      const agentTopics = agent.topics ?? ['general'];
      let score = 0;

      if (agentTopics.includes('general')) {
        score += 1; // base score for general agents
      }

      for (const topic of detectedTopics) {
        if (agentTopics.includes(topic)) {
          score += 2; // topic match is worth more
        }
      }

      return { agentId: agent.id, score };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Take top N, but at least min
    let selected = scored
      .filter((s) => s.score > 0)
      .slice(0, this.config.maxAgentsPerTurn)
      .map((s) => s.agentId);

    // Ensure minimum participants
    if (selected.length < this.config.minAgentsPerTurn) {
      const remaining = this.allAgents
        .filter((a) => !selected.includes(a.id))
        .slice(0, this.config.minAgentsPerTurn - selected.length);
      selected.push(...remaining.map((a) => a.id));
    }

    return selected;
  }

  /**
   * Determine which agents should join or leave based on topic shift.
   */
  detectRecruitment(
    message: string,
    currentParticipants: string[],
    skipCounts: Record<string, number>,
  ): ParticipationChange {
    const optimal = this.selectParticipants(message);

    const joining = optimal.filter((id) => !currentParticipants.includes(id));
    const leaving = currentParticipants.filter((id) => {
      const notOptimal = !optimal.includes(id);
      const hasBeenSilent = (skipCounts[id] ?? 0) >= 3;
      return notOptimal && hasBeenSilent;
    });

    return { joining, leaving };
  }

  private detectTopics(message: string): string[] {
    const lower = message.toLowerCase();
    const matched: string[] = [];

    for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
      const count = keywords.filter((kw) => lower.includes(kw.toLowerCase())).length;
      if (count > 0) {
        matched.push(topic);
      }
    }

    return matched;
  }
}
