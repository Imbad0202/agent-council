import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { HumanCritiqueStance } from '../council/human-critique.js';
import type {
  CritiquePromptResult,
  CritiqueRequest,
} from '../council/human-critique-wiring.js';
import { PendingCritiqueState } from './critique-state.js';

// Callback data scheme: critique:<stance|skip>:<threadId>
// Mirrors br-score:<code>:<score> / pvg-rotate:<role> so the handler lifecycle
// (answerCallbackQuery + ctx.match dispatch) matches the surrounding bot.ts
// code and tests can drive it with a bare ctx object.
export const CRITIQUE_CALLBACK_PATTERN =
  /^critique:(challenge|question|addPremise|skip):(-?\d+)$/;

// Virtual agentId used for the critique-prompt follow-up message. Not bound to
// a real bot; BotManager.sendMessage falls back to the first available bot
// when the agentId is unknown, which is what we want here.
export const CRITIQUE_PROMPT_AGENT_ID = 'critique-prompt';

type CritiqueSendFn = (text: string, threadId: number) => Promise<void>;

const STANCE_LABELS: Record<HumanCritiqueStance, string> = {
  challenge: 'challenge',
  question: 'question',
  addPremise: 'add premise',
};

export function buildCritiqueCallback(
  groupChatId: number,
  state: PendingCritiqueState,
  sendFn: CritiqueSendFn,
) {
  return async (ctx: Context) => {
    if (ctx.chat?.id !== groupChatId) return;
    if (!ctx.match || !Array.isArray(ctx.match)) return;
    const action = ctx.match[1] as HumanCritiqueStance | 'skip';
    const threadId = parseInt(ctx.match[2], 10);

    const pending = state.get(threadId);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'no pending critique for this thread' });
      return;
    }

    if (action === 'skip') {
      state.resolveSkipped(threadId);
      await ctx.answerCallbackQuery({ text: 'skipped' });
      return;
    }

    state.advanceToText(threadId, action);
    await ctx.answerCallbackQuery({ text: `type your ${STANCE_LABELS[action]}` });
    await sendFn(
      `Type your ${STANCE_LABELS[action]} as the next message in this thread.`,
      threadId,
    );
  };
}

type FallthroughFn = (ctx: Context) => Promise<void> | void;

// Intercepts message:text while a critique is in awaiting-text phase.
// Falls through to the default handler otherwise; returns true iff consumed
// (tests assert this; the runtime registration ignores the return value).
export function buildCritiqueTextHandler(
  groupChatId: number,
  state: PendingCritiqueState,
  fallthrough: FallthroughFn,
) {
  return async (ctx: Context): Promise<boolean> => {
    if (ctx.chat?.id !== groupChatId) return false;
    if (ctx.from?.is_bot) return false;
    const rawText = ctx.message?.text ?? '';
    const text = rawText.trim();
    const threadId = ctx.message?.message_thread_id ?? ctx.chat.id;
    const pending = state.get(threadId);
    if (!pending || pending.phase !== 'awaiting-text' || !text) {
      await fallthrough(ctx);
      return false;
    }
    state.resolveSubmitted(threadId, text);
    return true;
  };
}

export function buildCritiqueKeyboard(threadId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('Challenge', `critique:challenge:${threadId}`)
    .text('Question', `critique:question:${threadId}`)
    .row()
    .text('Add premise', `critique:addPremise:${threadId}`)
    .text('Skip', `critique:skip:${threadId}`);
}

type SendKeyboardFn = (
  text: string,
  keyboard: InlineKeyboard,
  threadId: number,
) => Promise<void>;

export interface CreateCritiquePromptUserInput {
  state: PendingCritiqueState;
  sendKeyboard: SendKeyboardFn;
  timeoutMs: number;
}

// Factory for the Telegram-flavored promptUser used by HumanCritiqueWiring.
// Sends the 4-button keyboard, parks a pending entry in state keyed by
// threadId, and returns a promise that the callback/text handlers resolve
// when the user taps a button (and, for stance buttons, types the text).
// If the initial keyboard send fails, we resolve skipped so the deliberation
// loop can't stall on a network blip.
export function createTelegramCritiquePromptUser(
  input: CreateCritiquePromptUserInput,
): (req: CritiqueRequest) => Promise<CritiquePromptResult> {
  const { state, sendKeyboard, timeoutMs } = input;
  return async (req) => {
    return new Promise<CritiquePromptResult>((resolve, reject) => {
      state.register(req.threadId, { resolve, reject, timeoutMs });
      const banner =
        `Human-in-the-loop critique window\n` +
        `Previous turn: ${req.prevAgent}. Next up: ${req.nextAgent}.\n` +
        `Tap a button to interject, or Skip.`;
      sendKeyboard(banner, buildCritiqueKeyboard(req.threadId), req.threadId).catch(() => {
        state.resolveSkipped(req.threadId);
      });
    });
  };
}
