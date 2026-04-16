import type {
  AgentConfig,
  AgentRole,
  AgentStats,
  Complexity,
  CouncilMessage,
  LLMProvider,
  ProviderMessage,
  ProviderResponse,
  SystemPromptPart,
  ThinkingConfig,
} from '../types.js';
import { buildSystemPrompt, buildSystemPromptParts } from './personality.js';

export class AgentWorker {
  readonly id: string;
  readonly name: string;
  private config: AgentConfig;
  private provider: LLMProvider;
  private memorySyncPath: string;
  private stats: AgentStats = {
    responseCount: 0,
    disagreementRate: 0,
    averageLength: 0,
    skipCount: 0,
    modelUsage: {},
  };

  constructor(config: AgentConfig, provider: LLMProvider, memorySyncPath: string) {
    this.id = config.id;
    this.name = config.name;
    this.config = config;
    this.provider = provider;
    this.memorySyncPath = memorySyncPath;
  }

  private resolveModel(complexity?: Complexity): string {
    if (complexity && this.config.models) {
      return this.config.models[complexity];
    }
    if (this.config.defaultModelTier && this.config.models) {
      return this.config.models[this.config.defaultModelTier];
    }
    return this.config.model;
  }

  private resolveThinking(complexity?: Complexity): ThinkingConfig | undefined {
    if (!complexity || !this.config.thinking) return undefined;
    const tier = this.config.thinking[complexity];
    if (!tier) return undefined;
    return { type: 'enabled', budget_tokens: tier.budget_tokens };
  }

  async respond(
    conversationHistory: CouncilMessage[],
    role: AgentRole,
    challengePrompt?: string,
    complexity?: Complexity,
  ): Promise<ProviderResponse> {
    let systemPrompt: string | SystemPromptPart[];
    if (this.config.cacheSystemPrompt) {
      const { stable, volatile } = buildSystemPromptParts(this.config, this.memorySyncPath, role);
      systemPrompt = [
        { text: `${stable}\n\n---\n\n`, cache: true },
        { text: volatile },
      ];
    } else {
      systemPrompt = buildSystemPrompt(this.config, this.memorySyncPath, role);
    }

    const messages: ProviderMessage[] = conversationHistory.map((msg) => {
      if (msg.role === 'human') {
        return { role: 'user' as const, content: msg.content };
      }
      if (msg.agentId === this.id) {
        return { role: 'assistant' as const, content: msg.content };
      }
      return { role: 'user' as const, content: `[${msg.agentId}]: ${msg.content}` };
    });

    if (challengePrompt) {
      messages.push({ role: 'user', content: `[System]: ${challengePrompt}` });
    }

    const model = this.resolveModel(complexity);
    const thinking = this.resolveThinking(complexity);

    const response = await this.provider.chat(messages, {
      model,
      systemPrompt,
      ...(thinking && { thinking }),
    });

    this.stats.responseCount++;
    const totalLength = this.stats.averageLength * (this.stats.responseCount - 1) + response.content.length;
    this.stats.averageLength = totalLength / this.stats.responseCount;

    if (response.skip) {
      this.stats.skipCount++;
    }

    if (!this.stats.modelUsage[model]) {
      this.stats.modelUsage[model] = { calls: 0, inputTokens: 0, outputTokens: 0 };
    }
    this.stats.modelUsage[model].calls++;
    this.stats.modelUsage[model].inputTokens += response.tokensUsed.input;
    this.stats.modelUsage[model].outputTokens += response.tokensUsed.output;

    return response;
  }

  getStats(): AgentStats {
    return { ...this.stats };
  }
}
