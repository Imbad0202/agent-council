import type { CouncilMessage } from '../types.js';

interface TelegramMessage {
  message_id: number;
  text?: string;
  date: number;
  from?: { id: number; first_name: string };
  message_thread_id?: number;
}

export function createCouncilMessageFromTelegram(msg: TelegramMessage): CouncilMessage {
  return {
    id: `tg-${msg.message_id}`,
    role: 'human',
    content: msg.text ?? '',
    timestamp: msg.date * 1000,
    threadId: msg.message_thread_id,
  };
}

export function formatAgentReply(agentId: string, agentName: string, content: string): string {
  return `🤖 ${agentName}\n\n${content}`;
}
