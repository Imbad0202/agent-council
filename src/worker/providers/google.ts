import { GoogleGenAI } from '@google/genai';
import type { LLMProvider, ProviderMessage, ChatOptions, ProviderResponse } from '../../types.js';

export class GoogleProvider implements LLMProvider {
  readonly name = 'google';
  private client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async chat(messages: ProviderMessage[], options: ChatOptions): Promise<ProviderResponse> {
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const response = await this.client.models.generateContent({
      model: options.model,
      contents,
      config: {
        maxOutputTokens: options.maxTokens ?? 2048,
        temperature: options.temperature ?? 0.7,
        systemInstruction: options.systemPrompt,
      },
    });

    const content = response.text ?? '';

    return {
      content,
      tokensUsed: {
        input: response.usageMetadata?.promptTokenCount ?? 0,
        output: response.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }

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
    return Math.ceil(totalChars / 4);
  }
}
