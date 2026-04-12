import OpenAI from 'openai';
import type { ProviderMessage, ChatOptions, ProviderResponse } from '../../types.js';
import { BaseProvider } from './base.js';

export class OpenAIProvider extends BaseProvider {
  readonly name = 'openai';
  private client: OpenAI;

  constructor(apiKey: string) {
    super();
    this.client = new OpenAI({ apiKey });
  }

  async chat(messages: ProviderMessage[], options: ChatOptions): Promise<ProviderResponse> {
    const openaiMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: options.systemPrompt },
      ...messages.filter((m) => m.role !== 'system').map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    ];

    const response = await this.client.chat.completions.create({
      model: options.model,
      messages: openaiMessages,
      max_tokens: options.maxTokens ?? 2048,
      temperature: options.temperature ?? 0.7,
    });

    const content = response.choices[0]?.message?.content ?? '';

    return {
      content,
      tokensUsed: {
        input: response.usage?.prompt_tokens ?? 0,
        output: response.usage?.completion_tokens ?? 0,
      },
    };
  }
}
