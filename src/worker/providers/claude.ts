import Anthropic from '@anthropic-ai/sdk';
import type { ProviderMessage, ChatOptions, ProviderResponse } from '../../types.js';
import { BaseProvider } from './base.js';

export class ClaudeProvider extends BaseProvider {
  readonly name = 'claude';
  private client: Anthropic;

  constructor(apiKey: string) {
    super();
    this.charsPerToken = 3;
    this.client = new Anthropic({ apiKey });
  }

  async chat(messages: ProviderMessage[], options: ChatOptions): Promise<ProviderResponse> {
    const anthropicMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    const response = await this.client.messages.create({
      model: options.model,
      max_tokens: options.maxTokens ?? 8192,
      temperature: options.temperature ?? 0.7,
      system: options.systemPrompt,
      messages: anthropicMessages,
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    const content = textBlock ? textBlock.text : '';

    return {
      content,
      tokensUsed: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
      },
    };
  }
}
