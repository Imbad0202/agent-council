import type { CouncilMessage, LLMProvider, AntiPatternConfig, PatternType } from '../types.js';
import { PATTERN_INJECTION_PROMPTS } from './pattern-prompts.js';

interface DetectionResult {
  pattern: PatternType;
  targetAgent: string;
}

export class PatternDetector {
  private config: AntiPatternConfig;
  private provider: LLMProvider;

  constructor(config: AntiPatternConfig, provider: LLMProvider) {
    this.config = config;
    this.provider = provider;
  }

  shouldDetect(turnCount: number): boolean {
    if (!this.config.enabled) return false;
    if (turnCount < this.config.startAfterTurn) return false;
    return turnCount % this.config.detectEveryNTurns === 0;
  }

  async detect(recentMessages: CouncilMessage[]): Promise<DetectionResult | null> {
    const last3 = recentMessages.slice(-3);
    if (last3.length < 2) return null;

    const transcript = last3
      .map((m) => {
        const speaker = m.role === 'human' ? 'Human' : m.agentId ?? 'Agent';
        return `${speaker}: ${m.content}`;
      })
      .join('\n\n');

    const response = await this.provider.chat(
      [{ role: 'user', content: `Analyze this exchange for anti-patterns:\n\n${transcript}` }],
      {
        model: this.config.detectionModel,
        systemPrompt: `You are detecting conversation anti-patterns between AI agents. Check for:

1. "mirror": Agent B's response is semantically identical to Agent A's, just rephrased.
2. "fake_dissent": Agent opens with "I disagree" but reaches the same conclusion.
3. "quick_surrender": Agent had a position last turn but immediately abandoned it after one challenge.
4. "authority_submission": Agent changed stance because the human sided with the other agent.

Respond in JSON:
{"pattern": "mirror"|"fake_dissent"|"quick_surrender"|"authority_submission"|null, "target_agent": "agent_id"|null}

If no pattern is detected, both fields should be null.`,
        maxTokens: 128,
        temperature: 0.1,
      },
    );

    try {
      const parsed = JSON.parse(response.content);
      if (parsed.pattern && parsed.target_agent) {
        return { pattern: parsed.pattern as PatternType, targetAgent: parsed.target_agent };
      }
    } catch {
      // Parse error — no pattern detected
    }

    return null;
  }

  getInjectionPrompt(pattern: PatternType): string {
    return PATTERN_INJECTION_PROMPTS[pattern];
  }
}
