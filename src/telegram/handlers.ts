import type { CouncilMessage } from '../types.js';
import type { AdversarialMode } from '../council/adversarial-provers.js';

interface TelegramMessage {
  message_id: number;
  text?: string;
  date: number;
  from?: { id: number; first_name: string };
  message_thread_id?: number;
}

export function createCouncilMessageFromTelegram(
  msg: TelegramMessage,
  options?: {
    stressTest?: boolean;
    blindReview?: boolean;
    adversarialMode?: AdversarialMode;
  },
): CouncilMessage {
  return {
    id: `tg-${msg.message_id}`,
    role: 'human',
    content: msg.text ?? '',
    timestamp: msg.date * 1000,
    threadId: msg.message_thread_id,
    ...(options?.stressTest ? { stressTest: true } : {}),
    ...(options?.blindReview ? { blindReview: true } : {}),
    ...(options?.adversarialMode ? { adversarialMode: options.adversarialMode } : {}),
  };
}

export function formatAgentReply(agentId: string, agentName: string, content: string): string {
  return `🤖 ${agentName}\n\n${content}`;
}
