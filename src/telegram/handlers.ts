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
    pvgRotate?: boolean;
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
    ...(options?.pvgRotate ? { pvgRotate: true } : {}),
  };
}

export function formatAgentReply(agentId: string, agentName: string, content: string): string {
  return `🤖 ${agentName}\n\n${content}`;
}

// Match the threadId normalization that GatewayRouter.handleHumanMessage does
// for ordinary text messages: undefined (non-forum chat, no topic) maps to 0,
// NOT to ctx.chat.id. Command handlers must use this so /councilreset,
// /councilhistory, and /cancelreview land on the same thread key as the
// deliberation they are acting on (round-9 codex finding).
export function resolveTelegramThreadId(
  ctxMessage: { message_thread_id?: number } | undefined,
): number {
  return ctxMessage?.message_thread_id ?? 0;
}
