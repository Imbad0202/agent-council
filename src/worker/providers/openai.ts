import OpenAI from 'openai';
import type { LLMProvider, ProviderMessage, ChatOptions, ProviderResponse } from '../../types.js';

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  private client: OpenAI;

  constructor(apiKey: string) {
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
