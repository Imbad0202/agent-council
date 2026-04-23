import { describe, it, expect, vi } from 'vitest';
import { PendingCritiqueState } from '../../src/telegram/critique-state.js';
import { buildCritiqueTextHandler } from '../../src/telegram/critique-callback.js';
import type { CritiquePromptResult } from '../../src/council/human-critique-wiring.js';

function makeCtx(opts: { chatId: number; threadId: number | undefined; text: string; fromBot?: boolean }) {
  return {
    chat: { id: opts.chatId },
    from: { is_bot: !!opts.fromBot },
    message: {
      text: opts.text,
      message_thread_id: opts.threadId,
    },
  } as any;
}

describe('buildCritiqueTextHandler', () => {
  it('resolves the pending critique with submitted when awaiting-text and text arrives', async () => {
    const state = new PendingCritiqueState();
    let resolved: CritiquePromptResult | undefined;
    state.register(77, {
      resolve: (r) => { resolved = r; },
    });
    state.advanceToText(77, 'challenge');
    const fallthrough = vi.fn();
    const handler = buildCritiqueTextHandler(100, state, fallthrough);

    const consumed = await handler(makeCtx({ chatId: 100, threadId: 77, text: 'cost ignored' }));

    expect(consumed).toBe(true);
    expect(resolved).toEqual({ kind: 'submitted', stance: 'challenge', content: 'cost ignored' });
    expect(fallthrough).not.toHaveBeenCalled();
  });

  it('falls through to the default handler when no critique is pending', async () => {
    const state = new PendingCritiqueState();
    const fallthrough = vi.fn();
    const handler = buildCritiqueTextHandler(100, state, fallthrough);

    const ctx = makeCtx({ chatId: 100, threadId: 42, text: 'normal message' });
    const consumed = await handler(ctx);

    expect(consumed).toBe(false);
    expect(fallthrough).toHaveBeenCalledWith(ctx);
  });

  it('falls through when the pending critique is still in awaiting-button phase', async () => {
    const state = new PendingCritiqueState();
    state.register(77, { resolve: vi.fn() });
    // still awaiting-button — user shouldn't be forced to type yet
    const fallthrough = vi.fn();
    const handler = buildCritiqueTextHandler(100, state, fallthrough);

    const ctx = makeCtx({ chatId: 100, threadId: 77, text: 'premature text' });
    const consumed = await handler(ctx);

    expect(consumed).toBe(false);
    expect(fallthrough).toHaveBeenCalledWith(ctx);
    expect(state.get(77)?.phase).toBe('awaiting-button');
  });

  it('ignores messages from wrong chat', async () => {
    const state = new PendingCritiqueState();
    const resolve = vi.fn();
    state.register(77, { resolve });
    state.advanceToText(77, 'question');
    const fallthrough = vi.fn();
    const handler = buildCritiqueTextHandler(100, state, fallthrough);

    const consumed = await handler(makeCtx({ chatId: 999, threadId: 77, text: 'hi' }));

    expect(consumed).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect(fallthrough).not.toHaveBeenCalled();
  });

  it('ignores messages from bots', async () => {
    const state = new PendingCritiqueState();
    const resolve = vi.fn();
    state.register(77, { resolve });
    state.advanceToText(77, 'question');
    const fallthrough = vi.fn();
    const handler = buildCritiqueTextHandler(100, state, fallthrough);

    const consumed = await handler(makeCtx({ chatId: 100, threadId: 77, text: 'bot text', fromBot: true }));

    expect(consumed).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });

  // Round-10 codex finding [P1]: non-forum Telegram chats have no
  // message_thread_id, and GatewayRouter normalizes those to threadId 0.
  // buildCritiqueTextHandler used to fall back to ctx.chat.id, which
  // landed on the wrong thread key for every critique in a non-forum
  // group. Normalize to 0 to match the rest of the codebase.
  it('normalizes missing message_thread_id to 0 (matches GatewayRouter), not chat.id', async () => {
    const state = new PendingCritiqueState();
    let resolved: CritiquePromptResult | undefined;
    // Pending state registered under thread 0 (same key GatewayRouter
    // used when the /critique was initiated in a non-forum group).
    state.register(0, {
      resolve: (r) => { resolved = r; },
    });
    state.advanceToText(0, 'addPremise');
    const fallthrough = vi.fn();
    const handler = buildCritiqueTextHandler(100, state, fallthrough);

    const consumed = await handler(makeCtx({ chatId: 100, threadId: undefined, text: 'premise text' }));

    expect(consumed).toBe(true);
    expect(resolved).toEqual({ kind: 'submitted', stance: 'addPremise', content: 'premise text' });
  });

  it('falls through when the message text is empty (whitespace trimmed)', async () => {
    const state = new PendingCritiqueState();
    const resolve = vi.fn();
    state.register(77, { resolve });
    state.advanceToText(77, 'question');
    const fallthrough = vi.fn();
    const handler = buildCritiqueTextHandler(100, state, fallthrough);

    const consumed = await handler(makeCtx({ chatId: 100, threadId: 77, text: '   ' }));

    expect(consumed).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect(state.get(77)?.phase).toBe('awaiting-text'); // still pending
  });
});
