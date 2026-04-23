import { describe, it, expect, vi } from 'vitest';
import { buildPvgRotateCallback } from '../../src/telegram/bot.js';
import { PvgRotateStore } from '../../src/council/pvg-rotate-store.js';
import { PvgRotateDB } from '../../src/council/pvg-rotate-db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('buildPvgRotateCallback', () => {
  it('records guess, renders reveal, deletes store entry', async () => {
    const store = new PvgRotateStore();
    store.create(42, 'biased-prover');
    store.attachDebrief(42, {
      role: 'biased-prover',
      agentId: 'agent-x',
      kind: 'anchoring',
      debrief: 'anchored on first estimate',
    });

    const dir = mkdtempSync(join(tmpdir(), 'pvg-cb-'));
    const db = new PvgRotateDB(join(dir, 'test.db'));
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const cb = buildPvgRotateCallback(42, store, db, sendFn);

    const ctx = {
      chat: { id: 42 },
      match: ['pvg-rotate-guess:biased-prover', 'biased-prover'],
      // Forum-topic case: explicit thread id that matches the session key.
      message: { message_thread_id: 42 },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    };

    await cb(ctx as any);

    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(sendFn).toHaveBeenCalledTimes(1);
    const content = sendFn.mock.calls[0][1];
    expect(content).toContain('✅');
    expect(content).toContain('biased');
    expect(store.get(42)).toBeUndefined();

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Round-10 codex finding [P1]: non-forum Telegram chats have no
  // message_thread_id, so GatewayRouter creates the pvg-rotate session
  // under thread 0. The callback used to fall back to ctx.chat.id which
  // missed the session entirely — every guess button became a no-op
  // ("no pvg-rotate session for this thread") in ordinary group chats.
  it('resolves threadId to 0 in non-forum chats (not ctx.chat.id)', async () => {
    const store = new PvgRotateStore();
    // Session created under thread 0, matching GatewayRouter normalization
    // for non-forum groups.
    store.create(0, 'biased-prover');
    store.attachDebrief(0, {
      role: 'biased-prover', agentId: 'agent-x', kind: 'anchoring', debrief: 'debrief',
    });

    const dir = mkdtempSync(join(tmpdir(), 'pvg-cb-nonforum-'));
    const db = new PvgRotateDB(join(dir, 'test.db'));
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const cb = buildPvgRotateCallback(100, store, db, sendFn);

    // Ctx simulates a non-forum group button press: ctx.chat.id=100 but no
    // message_thread_id on the button's parent message.
    const ctx = {
      chat: { id: 100 },
      match: ['pvg-rotate-guess:biased-prover', 'biased-prover'],
      message: {},
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    };

    await cb(ctx as any);
    // Guess landed under thread 0 where the session lives, so the callback
    // took the success branch (✅), not the "no session" branch.
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: '✅' }),
    );

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers with already-guessed when callback fires twice', async () => {
    const store = new PvgRotateStore();
    store.create(42, 'biased-prover');
    store.attachDebrief(42, {
      role: 'biased-prover', agentId: 'agent-x', kind: 'anchoring', debrief: 'x',
    });
    store.recordGuess(42, 'biased-prover');

    const dir = mkdtempSync(join(tmpdir(), 'pvg-cb-'));
    const db = new PvgRotateDB(join(dir, 'test.db'));
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const cb = buildPvgRotateCallback(42, store, db, sendFn);

    const ctx = {
      chat: { id: 42 },
      match: ['pvg-rotate-guess:sneaky-prover', 'sneaky-prover'],
      // Forum-topic case: explicit thread id that matches the session key.
      message: { message_thread_id: 42 },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    };

    await cb(ctx as any);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/already/i) }),
    );
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
