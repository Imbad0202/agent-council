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
      max_completion_tokens: options.maxTokens ?? 16384,
      temperature: options.temperature ?? 0.7,
    });

    const choice = response.choices[0];
    let content = choice?.message?.content ?? '';

    // Debug: log if content is empty
    if (!content.trim()) {
      console.error(`[OpenAI] Empty response from ${options.model}. finish_reason: ${choice?.finish_reason}, refusal: ${choice?.message?.refusal ?? 'none'}`);
      content = `（${options.model} 未回傳內容，finish_reason: ${choice?.finish_reason ?? 'unknown'}）`;
    }

    return {
      content,
      tokensUsed: {
        input: response.usage?.prompt_tokens ?? 0,
        output: response.usage?.completion_tokens ?? 0,
      },
    };
  }
}
