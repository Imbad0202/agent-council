import type {
  AgentConfig,
  AgentRole,
  AgentStats,
  CouncilMessage,
  LLMProvider,
  ProviderMessage,
  ProviderResponse,
} from '../types.js';
import { buildSystemPrompt } from './personality.js';

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
  };

  constructor(config: AgentConfig, provider: LLMProvider, memorySyncPath: string) {
    this.id = config.id;
    this.name = config.name;
    this.config = config;
    this.provider = provider;
    this.memorySyncPath = memorySyncPath;
  }

  async respond(
    conversationHistory: CouncilMessage[],
    role: AgentRole,
    challengePrompt?: string,
  ): Promise<ProviderResponse> {
    const systemPrompt = buildSystemPrompt(this.config, this.memorySyncPath, role);

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

    const response = await this.provider.chat(messages, {
      model: this.config.model,
      systemPrompt,
    });

    this.stats.responseCount++;
    const totalLength = this.stats.averageLength * (this.stats.responseCount - 1) + response.content.length;
    this.stats.averageLength = totalLength / this.stats.responseCount;

    if (response.skip) {
      this.stats.skipCount++;
    }

    return response;
  }

  getStats(): AgentStats {
    return { ...this.stats };
  }
}
