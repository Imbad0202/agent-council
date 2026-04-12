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

  private isRetryableError(err: unknown): boolean {
    if (err instanceof Error && 'status' in err) {
      const status = (err as { status: number }).status;
      return status === 429 || status === 503 || status === 529;
    }
    return false;
  }

  async chatWithFallback(
    messages: ProviderMessage[],
    options: ChatOptions,
    fallbackModels: string[],
  ): Promise<ProviderResponse> {
    const allModels = [options.model, ...fallbackModels];
    for (let i = 0; i < allModels.length; i++) {
      try {
        return await this.chat(messages, { ...options, model: allModels[i] });
      } catch (err) {
        const isLast = i === allModels.length - 1;
        if (this.isRetryableError(err) && !isLast) {
          console.log(`[Fallback] ${allModels[i]} failed, trying ${allModels[i + 1]}...`);
          continue;
        }
        throw err;
      }
    }
    throw new Error('All models exhausted');
  }
}
