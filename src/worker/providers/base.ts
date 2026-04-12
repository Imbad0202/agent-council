import type { LLMProvider, ProviderMessage, ChatOptions, ProviderResponse } from '../../types.js';

export abstract class BaseProvider implements LLMProvider {
  abstract readonly name: string;
  abstract chat(messages: ProviderMessage[], options: ChatOptions): Promise<ProviderResponse>;

  protected charsPerToken = 4;

  async summarize(text: string, model: string): Promise<string> {
    const response = await this.chat(
      [{ role: 'user', content: text }],
      {
        model,
        systemPrompt: 'Summarize the following discussion concisely in 200-300 words. Capture key conclusions, differing perspectives, and unresolved points. Respond in the same language as the input.',
        maxTokens: 1024,
        temperature: 0.3,
      },
    );
    return response.content;
  }

  estimateTokens(messages: ProviderMessage[]): number {
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    return Math.ceil(totalChars / this.charsPerToken);
  }
}
