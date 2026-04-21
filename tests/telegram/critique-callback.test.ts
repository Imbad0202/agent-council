import { describe, it, expect, vi } from 'vitest';
import { PendingCritiqueState } from '../../src/telegram/critique-state.js';
import { buildCritiqueCallback, CRITIQUE_CALLBACK_PATTERN } from '../../src/telegram/critique-callback.js';
import type { CritiquePromptResult } from '../../src/council/human-critique-wiring.js';

describe('critique callback handler', () => {
  it('exposes a regex that matches the four button variants with threadId', () => {
    const samples = [
      ['critique:challenge:42', 'challenge', '42'],
      ['critique:question:7', 'question', '7'],
      ['critique:addPremise:0', 'addPremise', '0'],
      ['critique:skip:-100', 'skip', '-100'],
    ];
    for (const [data, stance, tid] of samples) {
      const m = data.match(CRITIQUE_CALLBACK_PATTERN);
      expect(m, `expected match for ${data}`).not.toBeNull();
      expect(m![1]).toBe(stance);
      expect(m![2]).toBe(tid);
    }
    expect('critique:bogus:1'.match(CRITIQUE_CALLBACK_PATTERN)).toBeNull();
  });

  it('skip button resolves the pending critique as skipped and acknowledges', async () => {
    const state = new PendingCritiqueState();
    let resolved: CritiquePromptResult | undefined;
    state.register(55, {
      resolve: (r) => { resolved = r; },
      reject: vi.fn(),
      timeoutMs: 30_000,
    });
    const sendFn = vi.fn();

    const ctx: any = {
      chat: { id: 100 },
      match: ['critique:skip:55', 'skip', '55'],
      answerCallbackQuery: vi.fn(),
    };

    const cb = buildCritiqueCallback(100, state, sendFn);
    await cb(ctx);

    expect(resolved).toEqual({ kind: 'skipped' });
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(state.get(55)).toBeUndefined();
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('challenge button advances state to awaiting-text and prompts user', async () => {
    const state = new PendingCritiqueState();
    const resolve = vi.fn();
    state.register(77, { resolve, reject: vi.fn(), timeoutMs: 30_000 });
    const sendFn = vi.fn();

    const ctx: any = {
      chat: { id: 100 },
      match: ['critique:challenge:77', 'challenge', '77'],
      answerCallbackQuery: vi.fn(),
    };

    const cb = buildCritiqueCallback(100, state, sendFn);
    await cb(ctx);

    expect(resolve).not.toHaveBeenCalled();
    expect(state.get(77)).toMatchObject({ phase: 'awaiting-text', stance: 'challenge' });
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(sendFn).toHaveBeenCalledTimes(1);
    // Follow-up prompt asks for the text, addressed to the thread
    expect(sendFn.mock.calls[0][1]).toBe(77);
    expect(typeof sendFn.mock.calls[0][0]).toBe('string');
    expect(sendFn.mock.calls[0][0]).toMatch(/challenge/i);
  });

  it('question and addPremise buttons also transition to awaiting-text', async () => {
    const state = new PendingCritiqueState();
    state.register(1, { resolve: vi.fn(), reject: vi.fn(), timeoutMs: 30_000 });
    state.register(2, { resolve: vi.fn(), reject: vi.fn(), timeoutMs: 30_000 });
    const sendFn = vi.fn();
    const cb = buildCritiqueCallback(100, state, sendFn);

    await cb({
      chat: { id: 100 },
      match: ['critique:question:1', 'question', '1'],
      answerCallbackQuery: vi.fn(),
    } as any);
    await cb({
      chat: { id: 100 },
      match: ['critique:addPremise:2', 'addPremise', '2'],
      answerCallbackQuery: vi.fn(),
    } as any);

    expect(state.get(1)?.stance).toBe('question');
    expect(state.get(2)?.stance).toBe('addPremise');
  });

  it('ignores callback from wrong chat', async () => {
    const state = new PendingCritiqueState();
    const resolve = vi.fn();
    state.register(55, { resolve, reject: vi.fn(), timeoutMs: 30_000 });
    const sendFn = vi.fn();
    const ctx: any = {
      chat: { id: 999 },
      match: ['critique:skip:55', 'skip', '55'],
      answerCallbackQuery: vi.fn(),
    };

    await buildCritiqueCallback(100, state, sendFn)(ctx);

    expect(resolve).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
    expect(sendFn).not.toHaveBeenCalled();
    expect(state.get(55)).toBeDefined();
  });

  it('answers with a toast if the threadId has no pending critique', async () => {
    const state = new PendingCritiqueState();
    const sendFn = vi.fn();
    const ctx: any = {
      chat: { id: 100 },
      match: ['critique:challenge:404', 'challenge', '404'],
      answerCallbackQuery: vi.fn(),
    };

    await buildCritiqueCallback(100, state, sendFn)(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringMatching(/no.*critique/i),
    }));
    expect(sendFn).not.toHaveBeenCalled();
  });
});
