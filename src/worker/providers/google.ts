import { GoogleGenAI } from '@google/genai';
import type { ProviderMessage, ChatOptions, ProviderResponse } from '../../types.js';
import { BaseProvider, flattenSystemPrompt } from './base.js';

export class GoogleProvider extends BaseProvider {
  readonly name = 'google';
  private client: GoogleGenAI;

  constructor(apiKey: string) {
    super();
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
        systemInstruction: flattenSystemPrompt(options.systemPrompt),
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
}
