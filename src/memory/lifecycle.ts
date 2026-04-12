import type { CouncilMessage, LLMProvider, MemoryConfig } from '../types.js';

interface TopicOutcome {
  topic: string;
  outcome: 'decision' | 'open' | 'deferred';
  confidence: number;
}

export class SessionLifecycle {
  private config: MemoryConfig;
  private provider: LLMProvider;
  private model: string;

  constructor(config: MemoryConfig, provider: LLMProvider, model: string) {
    this.config = config;
    this.provider = provider;
    this.model = model;
  }

  isEndKeyword(message: string): boolean {
    const lower = message.toLowerCase();
    return this.config.endKeywords.some((kw) => lower.includes(kw.toLowerCase()));
  }

  async extractTopicAndOutcome(messages: CouncilMessage[]): Promise<TopicOutcome> {
    const transcript = messages
      .slice(-10)
      .map((m) => {
        const speaker = m.role === 'human' ? 'Human' : m.agentId ?? 'Agent';
        return `${speaker}: ${m.content}`;
      })
      .join('\n');

    const response = await this.provider.chat(
      [{ role: 'user', content: `Analyze this discussion:\n\n${transcript}` }],
      {
        model: this.model,
        systemPrompt: `Extract the main topic and outcome of this discussion.

Respond in JSON format:
{
  "topic": "short-topic-slug (e.g., 'architecture', 'monorepo', 'testing-strategy')",
  "outcome": "decision" | "open" | "deferred",
  "confidence": 0.0-1.0
}

Rules:
- "decision": the group reached a clear conclusion
- "open": still being discussed, no conclusion
- "deferred": explicitly postponed for later
- confidence: how certain are you about the conclusion (1.0 = very clear, 0.3 = ambiguous)`,
        maxTokens: 256,
        temperature: 0.2,
      },
    );

    try {
      const parsed = JSON.parse(response.content);
      return {
        topic: parsed.topic ?? 'general',
        outcome: parsed.outcome ?? 'open',
        confidence: parsed.confidence ?? 0.5,
      };
    } catch {
      return { topic: 'general', outcome: 'open', confidence: 0.5 };
    }
  }
}
