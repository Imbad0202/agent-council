import Anthropic from '@anthropic-ai/sdk';
import type { ProviderMessage, ChatOptions, ProviderResponse, SystemPromptPart } from '../../types.js';
import { BaseProvider } from './base.js';

function toAnthropicSystem(systemPrompt: string | SystemPromptPart[]) {
  if (typeof systemPrompt === 'string') return systemPrompt;
  return systemPrompt.map((part) => ({
    type: 'text' as const,
    text: part.text,
    ...(part.cache && { cache_control: { type: 'ephemeral' as const } }),
  }));
}

export class ClaudeProvider extends BaseProvider {
  readonly name = 'claude';
  private client: Anthropic;

  constructor(apiKey: string) {
    super();
    this.charsPerToken = 3;
    this.client = new Anthropic({ apiKey });
  }

  async chat(messages: ProviderMessage[], options: ChatOptions): Promise<ProviderResponse> {
    if (options.thinking && options.temperature !== undefined && options.temperature !== 1) {
      throw new Error(`Anthropic requires temperature=1 when thinking is enabled; got ${options.temperature}`);
    }

    const anthropicMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    const response = await this.client.messages.create({
      model: options.model,
      max_tokens: options.maxTokens ?? 8192,
      temperature: options.thinking ? 1 : (options.temperature ?? 0.7),
      system: toAnthropicSystem(options.systemPrompt),
      messages: anthropicMessages,
      ...(options.thinking && { thinking: options.thinking }),
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    const thinkingBlock = response.content.find((block) => block.type === 'thinking');
    const content = textBlock ? textBlock.text : '';

    return {
      content,
      ...(thinkingBlock && { thinking: thinkingBlock.thinking }),
      tokensUsed: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
      },
    };
  }
}
