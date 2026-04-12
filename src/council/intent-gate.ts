import type { EventBus } from '../events/bus.js';
import type { CouncilMessage, IntentType, Complexity, LLMProvider } from '../types.js';
import { detectTopics } from './topics.js';

const META_KEYWORDS = ['結束', 'done', '結論', 'wrap up', '總結', '換個角度', '重新開始'];
const IMPL_KEYWORDS = ['實作', 'implement', '寫', 'build', 'create', 'add feature', '建立', '開發'];
const INVESTIGATE_KEYWORDS = ['為什麼', 'why', 'debug', '調查', '怎麼壞的', 'investigate', '出了什麼問題'];

interface ClassificationResult {
  intent: IntentType;
  complexity: Complexity;
  confidence: number;
}

export class IntentGate {
  private bus: EventBus;
  private provider: LLMProvider;

  constructor(bus: EventBus, provider: LLMProvider) {
    this.bus = bus;
    this.provider = provider;
    this.bus.on('message.received', (payload) => {
      this.classify(payload.message, payload.threadId);
    });
  }

  private async classify(message: CouncilMessage, threadId: number): Promise<void> {
    const result = this.keywordClassify(message.content);
    if (result.confidence >= 0.7) {
      this.bus.emit('intent.classified', { intent: result.intent, complexity: result.complexity, threadId, message });
      return;
    }
    const llmResult = await this.llmClassify(message.content);
    this.bus.emit('intent.classified', { intent: llmResult.intent, complexity: llmResult.complexity, threadId, message });
  }

  private keywordClassify(content: string): ClassificationResult {
    const lower = content.toLowerCase();
    if (META_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))) {
      return { intent: 'meta', complexity: 'low', confidence: 0.9 };
    }
    if (IMPL_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))) {
      return { intent: 'implementation', complexity: this.assessComplexity(content), confidence: 0.8 };
    }
    if (INVESTIGATE_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))) {
      return { intent: 'investigation', complexity: this.assessComplexity(content), confidence: 0.8 };
    }
    if (content.length < 50 && (content.includes('？') || content.includes('?'))) {
      return { intent: 'quick-answer', complexity: 'low', confidence: 0.7 };
    }
    return { intent: 'deliberation', complexity: this.assessComplexity(content), confidence: 0.5 };
  }

  private assessComplexity(content: string): Complexity {
    const topics = detectTopics(content);
    const hasCodeBlock = content.includes('```');
    if (content.length < 50 && topics.length <= 1 && !hasCodeBlock) return 'low';
    if (content.length > 300 || topics.length >= 3 || hasCodeBlock) return 'high';
    return 'medium';
  }

  private async llmClassify(content: string): Promise<ClassificationResult> {
    try {
      const response = await this.provider.chat(
        [{ role: 'user', content: `Classify this message:\n\n${content}` }],
        {
          model: 'claude-haiku-4-5-20251001',
          systemPrompt: 'Classify the user message into:\nintent: "deliberation" | "quick-answer" | "implementation" | "investigation" | "meta"\ncomplexity: "low" | "medium" | "high"\n\nRespond in JSON: {"intent": "...", "complexity": "..."}',
          maxTokens: 64, temperature: 0.1,
        },
      );
      const parsed = JSON.parse(response.content);
      return { intent: parsed.intent ?? 'deliberation', complexity: parsed.complexity ?? 'medium', confidence: 0.85 };
    } catch {
      return { intent: 'deliberation', complexity: 'medium', confidence: 0.5 };
    }
  }
}
