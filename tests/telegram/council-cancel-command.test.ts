import { describe, it, expect, vi } from 'vitest';
import { buildCouncilCancelHandler } from '../../src/telegram/bot.js';
import { ResetCancelledError } from '../../src/council/session-reset-errors.js';

const GROUP = 100;

function makeCtx(overrides: { chat_id?: number; from_bot?: boolean; message_thread_id?: number } = {}) {
  const threadId = overrides.message_thread_id;
  const message = threadId !== undefined ? { message_thread_id: threadId } : {};
  return {
    chat: { id: overrides.chat_id ?? GROUP },
    from: { is_bot: overrides.from_bot ?? false },
    message,
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

describe('buildCouncilCancelHandler (v0.5.4 §7.6)', () => {
  it('with active reset → calls abort with ResetCancelledError(user), replies "Reset cancelled."', async () => {
    const ctrl = new AbortController();
    const wiring = {
      db: {} as never,
      reset: {} as never,
      deliberationHandler: {
        getCurrentResetController: vi.fn(() => ctrl),
      } as never,
    };
    const handler = buildCouncilCancelHandler(GROUP, wiring);
    const ctx = makeCtx();
    await handler(ctx as never);
    expect(ctrl.signal.aborted).toBe(true);
    expect(ctrl.signal.reason).toBeInstanceOf(ResetCancelledError);
    expect((ctrl.signal.reason as ResetCancelledError).reason).toBe('user');
    expect(ctx.reply).toHaveBeenCalledWith('Reset cancelled.');
  });

  it('with no reset in progress → replies "No reset in progress."', async () => {
    const wiring = {
      db: {} as never,
      reset: {} as never,
      deliberationHandler: {
        getCurrentResetController: vi.fn(() => null),
      } as never,
    };
    const handler = buildCouncilCancelHandler(GROUP, wiring);
    const ctx = makeCtx();
    await handler(ctx as never);
    expect(ctx.reply).toHaveBeenCalledWith('No reset in progress.');
  });

  it('with DB-only-without-facilitator wiring → replies "not configured" message', async () => {
    const wiring = { db: {} as never };
    const handler = buildCouncilCancelHandler(GROUP, wiring);
    const ctx = makeCtx();
    await handler(ctx as never);
    expect(ctx.reply).toHaveBeenCalledWith(
      'Reset cancellation requires a facilitator agent (not configured).',
    );
  });

  it('ignores messages from wrong chat', async () => {
    const ctrl = new AbortController();
    const wiring = {
      db: {} as never,
      deliberationHandler: { getCurrentResetController: vi.fn(() => ctrl) } as never,
    };
    const handler = buildCouncilCancelHandler(GROUP, wiring);
    const ctx = makeCtx({ chat_id: 999 });
    await handler(ctx as never);
    expect(ctrl.signal.aborted).toBe(false);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('ignores messages from bots', async () => {
    const ctrl = new AbortController();
    const wiring = {
      db: {} as never,
      deliberationHandler: { getCurrentResetController: vi.fn(() => ctrl) } as never,
    };
    const handler = buildCouncilCancelHandler(GROUP, wiring);
    const ctx = makeCtx({ from_bot: true });
    await handler(ctx as never);
    expect(ctrl.signal.aborted).toBe(false);
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});
