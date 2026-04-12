import type { LLMProvider, ProviderMessage, ChatOptions, ProviderResponse } from '../../types.js';

export class CustomProvider implements LLMProvider {
  readonly name = 'custom';
  private baseUrl: string;
  private apiKey: string | undefined;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // remove trailing slash
    this.apiKey = apiKey;
  }

  async chat(messages: ProviderMessage[], options: ChatOptions): Promise<ProviderResponse> {
    const body = {
      model: options.model,
      messages: [
        { role: 'system', content: options.systemPrompt },
        ...messages.filter((m) => m.role !== 'system').map((m) => ({
          role: m.role,
          content: m.content,
        })),
      ],
      max_tokens: options.maxTokens ?? 2048,
      temperature: options.temperature ?? 0.7,
    };

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Custom provider error: ${res.status} ${await res.text()}`);
    }

    const data = await res.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    return {
      content: data.choices[0]?.message?.content ?? '',
      tokensUsed: {
        input: data.usage?.prompt_tokens ?? 0,
        output: data.usage?.completion_tokens ?? 0,
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
