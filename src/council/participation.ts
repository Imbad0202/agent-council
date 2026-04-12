import type { AgentConfig, ParticipationConfig } from '../types.js';
import { detectTopics } from './topics.js';

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
    const detectedTopics = detectTopics(message);

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
}
