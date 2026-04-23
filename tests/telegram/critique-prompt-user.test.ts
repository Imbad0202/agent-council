import { describe, it, expect, vi } from 'vitest';
import { PendingCritiqueState } from '../../src/telegram/critique-state.js';
import { createTelegramCritiquePromptUser } from '../../src/telegram/critique-callback.js';
import type { CritiquePromptResult } from '../../src/council/human-critique-wiring.js';

describe('createTelegramCritiquePromptUser', () => {
  it('sends keyboard to the thread, registers state, returns a pending promise', async () => {
    const state = new PendingCritiqueState();
    const sendKeyboard = vi.fn().mockResolvedValue(undefined);
    const promptUser = createTelegramCritiquePromptUser({
      state,
      sendKeyboard,
    });

    const pending = promptUser({ threadId: 42, prevAgent: 'huahua', nextAgent: 'binbin' });

    // Not yet resolved
    let settled = false;
    pending.then(() => { settled = true; }).catch(() => { settled = true; });
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);

    expect(sendKeyboard).toHaveBeenCalledTimes(1);
    const [text, keyboard, threadId] = sendKeyboard.mock.calls[0];
    expect(typeof text).toBe('string');
    expect(text).toMatch(/huahua/);
    expect(text).toMatch(/binbin/);
    expect(threadId).toBe(42);
    // The keyboard arg should be an InlineKeyboard-like object (we just check
    // shape is non-trivial; full grammY construction is the factory's job)
    expect(keyboard).toBeDefined();

    expect(state.get(42)).toMatchObject({ phase: 'awaiting-button' });

    // Simulate skip button fired — promise should resolve
    state.resolveSkipped(42);
    const result = await pending;
    expect(result).toEqual({ kind: 'skipped' });
  });

  it('promise resolves with submitted once state.resolveSubmitted runs', async () => {
    const state = new PendingCritiqueState();
    const sendKeyboard = vi.fn().mockResolvedValue(undefined);
    const promptUser = createTelegramCritiquePromptUser({
      state,
      sendKeyboard,
    });

    const pending = promptUser({ threadId: 7, prevAgent: 'a', nextAgent: 'b' });
    state.advanceToText(7, 'challenge');
    state.resolveSubmitted(7, 'evidence ignored');

    const result: CritiquePromptResult = await pending;
    expect(result).toEqual({ kind: 'submitted', stance: 'challenge', content: 'evidence ignored' });
  });

  it('if sendKeyboard throws, the promise resolves as skipped (never hangs)', async () => {
    const state = new PendingCritiqueState();
    const sendKeyboard = vi.fn().mockRejectedValue(new Error('network down'));
    const promptUser = createTelegramCritiquePromptUser({
      state,
      sendKeyboard,
    });

    const result = await promptUser({ threadId: 9, prevAgent: 'a', nextAgent: 'b' });
    expect(result).toEqual({ kind: 'skipped' });
    expect(state.get(9)).toBeUndefined();
  });
});
