import type { CouncilMessage, LLMProvider } from '../types.js';

export class ContextHealthMonitor {
  private messages: CouncilMessage[] = [];
  private compressedSummary: string | null = null;
  private windowSize: number;
  private provider: LLMProvider;
  private model: string;

  constructor(windowSize: number, provider: LLMProvider, model: string) {
    this.windowSize = windowSize;
    this.provider = provider;
    this.model = model;
  }

  addMessage(message: CouncilMessage): void {
    this.messages.push(message);
  }

  getContextMessages(): CouncilMessage[] {
    const result: CouncilMessage[] = [];

    if (this.compressedSummary) {
      result.push({
        id: 'compressed-summary',
        role: 'agent',
        content: `[Earlier discussion summary]: ${this.compressedSummary}`,
        timestamp: this.messages[0].timestamp,
      });
    }

    if (this.messages.length <= this.windowSize) {
      result.push(...this.messages);
    } else {
      const recentMessages = this.messages.slice(-this.windowSize);
      result.push(...recentMessages);
    }

    return result;
  }

  async compress(): Promise<void> {
    if (this.messages.length <= this.windowSize) {
      return;
    }

    const oldMessages = this.messages.slice(0, -this.windowSize);
    const textToCompress = oldMessages
      .map((m) => {
        const speaker = m.role === 'human' ? 'Human' : m.agentId ?? 'Agent';
        return `${speaker}: ${m.content}`;
      })
      .join('\n\n');

    const prefix = this.compressedSummary
      ? `Previous summary: ${this.compressedSummary}\n\nNew messages to incorporate:\n${textToCompress}`
      : textToCompress;

    this.compressedSummary = await this.provider.summarize(prefix, this.model);

    this.messages = this.messages.slice(-this.windowSize);
  }

  getFullHistory(): CouncilMessage[] {
    return [...this.messages];
  }

  reset(): void {
    this.messages = [];
    this.compressedSummary = null;
  }
}
