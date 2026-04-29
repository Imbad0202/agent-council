import type { ProviderMessage, ChatOptions, ProviderResponse } from '../../types.js';
import { BaseProvider } from './base.js';
import { mergeSignals } from '../../abort-utils.js';

export class CustomProvider extends BaseProvider {
  readonly name = 'custom';
  private baseUrl: string;
  private apiKey: string | undefined;

  constructor(baseUrl: string, apiKey?: string) {
    super();
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
      signal: mergeSignals(options.signal, AbortSignal.timeout(60_000)),
    });

    if (!res.ok) {
      const err = Object.assign(
        new Error(`Custom provider error: ${res.status} ${await res.text()}`),
        { status: res.status },
      );
      throw err;
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
}
