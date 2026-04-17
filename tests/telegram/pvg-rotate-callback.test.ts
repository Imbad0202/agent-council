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
      message: { message_thread_id: undefined },
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
      message: { message_thread_id: undefined },
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
