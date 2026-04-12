import { Bot } from 'grammy';
import type { GatewayRouter } from '../gateway/router.js';
import { createCouncilMessageFromTelegram, formatAgentReply } from './handlers.js';

interface BotConfig {
  token: string;
  groupChatId: number;
  agentNames: Record<string, string>;
}

// Track the latest message_thread_id so responses go to the same topic
let lastMessageThreadId: number | undefined;

export function getLastMessageThreadId(): number | undefined {
  return lastMessageThreadId;
}

export function createBot(botConfig: BotConfig, router: GatewayRouter): Bot {
  const bot = new Bot(botConfig.token);

  bot.on('message:text', async (ctx) => {
    if (ctx.chat.id !== botConfig.groupChatId) return;
    if (ctx.from?.is_bot) return;

    // Track topic thread for forum-enabled groups
    lastMessageThreadId = ctx.message.message_thread_id;

    const councilMsg = createCouncilMessageFromTelegram(ctx.message);

    await router.handleHumanMessage(councilMsg);
  });

  return bot;
}
