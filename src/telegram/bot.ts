import { Bot } from 'grammy';
import type { GatewayRouter } from '../gateway/router.js';
import { createCouncilMessageFromTelegram, formatAgentReply } from './handlers.js';

interface BotConfig {
  token: string;
  groupChatId: number;
  agentNames: Record<string, string>;
}

export function createBot(botConfig: BotConfig, router: GatewayRouter): Bot {
  const bot = new Bot(botConfig.token);

  bot.on('message:text', async (ctx) => {
    if (ctx.chat.id !== botConfig.groupChatId) return;
    if (ctx.from?.is_bot) return;

    const councilMsg = createCouncilMessageFromTelegram(ctx.message);

    await router.handleHumanMessage(councilMsg);
  });

  return bot;
}
