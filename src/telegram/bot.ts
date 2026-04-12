import { Bot } from 'grammy';
import type { GatewayRouter } from '../gateway/router.js';
import { createCouncilMessageFromTelegram } from './handlers.js';
import type { AgentConfig } from '../types.js';

interface MultiBotConfig {
  groupChatId: number;
  agents: AgentConfig[];
  listenerAgentId: string;
}

export class BotManager {
  private bots: Map<string, Bot> = new Map();
  private groupChatId: number;
  private listenerAgentId: string;

  constructor(config: MultiBotConfig) {
    this.groupChatId = config.groupChatId;
    this.listenerAgentId = config.listenerAgentId || config.agents[0]?.id || '';

    for (const agent of config.agents) {
      const tokenEnv = agent.botTokenEnv;
      const token = tokenEnv ? process.env[tokenEnv] : process.env['TELEGRAM_BOT_TOKEN'];
      if (token) {
        this.bots.set(agent.id, new Bot(token));
      }
    }

    // Fallback: if no per-agent tokens, use single TELEGRAM_BOT_TOKEN for all
    if (this.bots.size === 0) {
      const fallbackToken = process.env['TELEGRAM_BOT_TOKEN'];
      if (fallbackToken) {
        const fallbackBot = new Bot(fallbackToken);
        for (const agent of config.agents) {
          this.bots.set(agent.id, fallbackBot);
        }
      }
    }
  }

  setupListener(router: GatewayRouter): void {
    const listenerBot = this.bots.get(this.listenerAgentId);
    if (!listenerBot) {
      throw new Error(`Listener bot not found for agent: ${this.listenerAgentId}`);
    }

    listenerBot.on('message:text', async (ctx) => {
      if (ctx.chat.id !== this.groupChatId) return;
      if (ctx.from?.is_bot) return;

      const councilMsg = createCouncilMessageFromTelegram(ctx.message);
      await router.handleHumanMessage(councilMsg);
    });
  }

  async sendMessage(agentId: string, agentName: string, content: string, threadId?: number): Promise<void> {
    const bot = this.bots.get(agentId);
    if (!bot) {
      // Fallback to any available bot
      const fallbackBot = this.bots.values().next().value;
      if (!fallbackBot) return;
      const formatted = `🤖 ${agentName}\n\n${content}`;
      await fallbackBot.api.sendMessage(this.groupChatId, formatted, {
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
      return;
    }

    // When using per-agent bots, no need for name prefix — bot identity IS the name
    await bot.api.sendMessage(this.groupChatId, content, {
      ...(threadId ? { message_thread_id: threadId } : {}),
    });
  }

  getListenerBot(): Bot {
    const bot = this.bots.get(this.listenerAgentId);
    if (!bot) throw new Error(`Listener bot not found: ${this.listenerAgentId}`);
    return bot;
  }

  getBotCount(): number {
    return this.bots.size;
  }

  getAgentIds(): string[] {
    return [...this.bots.keys()];
  }
}
