import { Bot, Context, InlineKeyboard } from 'grammy';
import { createCouncilMessageFromTelegram } from './handlers.js';
import type { AgentConfig, CouncilMessage } from '../types.js';

export function buildStressTestHandler(
  groupChatId: number,
  handler: { handleHumanMessage: (msg: CouncilMessage) => void },
) {
  return async (ctx: Context) => {
    if (ctx.chat?.id !== groupChatId) return;
    if (ctx.from?.is_bot) return;

    const message = ctx.match?.toString().trim() ?? '';
    if (!message) {
      await ctx.reply(
        'Usage: /stresstest <your question>\nOne agent will play sneaky-prover (planted plausible error) so you can practice spotting it.',
      );
      return;
    }

    if (!ctx.message) return;
    const councilMsg = createCouncilMessageFromTelegram(ctx.message, { stressTest: true });
    handler.handleHumanMessage(councilMsg);
  };
}

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

  setupListener(handler: { handleHumanMessage: (msg: CouncilMessage) => void }): void {
    const listenerBot = this.bots.get(this.listenerAgentId);
    if (!listenerBot) {
      throw new Error(`Listener bot not found for agent: ${this.listenerAgentId}`);
    }

    listenerBot.command('stresstest', buildStressTestHandler(this.groupChatId, handler));

    listenerBot.on('message:text', async (ctx) => {
      if (ctx.chat.id !== this.groupChatId) return;
      if (ctx.from?.is_bot) return;

      const councilMsg = createCouncilMessageFromTelegram(ctx.message);
      handler.handleHumanMessage(councilMsg);
    });
  }

  private splitMessage(text: string, maxLength = 4096): string[] {
    if (text.length <= maxLength) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }
      // Try to split at last newline within limit
      let splitAt = remaining.lastIndexOf('\n', maxLength);
      if (splitAt <= 0) splitAt = maxLength;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).replace(/^\n/, '');
    }
    return chunks;
  }

  async sendMessage(agentId: string, agentName: string, content: string, threadId?: number): Promise<void> {
    const bot = this.bots.get(agentId);
    const opts = threadId ? { message_thread_id: threadId } : {};

    if (!bot) {
      // Fallback to any available bot
      const fallbackBot = this.bots.values().next().value;
      if (!fallbackBot) return;
      const formatted = `🤖 ${agentName}\n\n${content}`;
      for (const chunk of this.splitMessage(formatted)) {
        await fallbackBot.api.sendMessage(this.groupChatId, chunk, opts);
      }
      return;
    }

    // When using per-agent bots, no need for name prefix — bot identity IS the name
    for (const chunk of this.splitMessage(content)) {
      await bot.api.sendMessage(this.groupChatId, chunk, opts);
    }
  }

  async sendMessageWithKeyboard(
    agentId: string,
    content: string,
    keyboard: InlineKeyboard,
    threadId?: number,
  ): Promise<void> {
    const bot = this.bots.get(agentId) ?? this.bots.values().next().value;
    if (!bot) return;
    const opts: { reply_markup: InlineKeyboard; message_thread_id?: number } = {
      reply_markup: keyboard,
    };
    if (threadId) opts.message_thread_id = threadId;
    await bot.api.sendMessage(this.groupChatId, content, opts);
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
