import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PendingCritiqueState,
  type PendingCritique,
} from '../../src/telegram/critique-state.js';
import type { CritiquePromptResult } from '../../src/council/human-critique-wiring.js';

describe('PendingCritiqueState', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('register() stores a pending critique in awaiting-button phase', () => {
    const state = new PendingCritiqueState();
    const resolve = vi.fn();
    state.register(42, { resolve, reject: vi.fn(), timeoutMs: 10_000 });

    const pending = state.get(42);
    expect(pending).toBeDefined();
    expect(pending!.phase).toBe('awaiting-button');
    expect(pending!.stance).toBeUndefined();
  });

  it('register() throws if a critique is already pending for the threadId', () => {
    const state = new PendingCritiqueState();
    state.register(1, { resolve: vi.fn(), reject: vi.fn(), timeoutMs: 10_000 });
    expect(() =>
      state.register(1, { resolve: vi.fn(), reject: vi.fn(), timeoutMs: 10_000 }),
    ).toThrow(/already pending/i);
  });

  it('advanceToText() flips awaiting-button → awaiting-text and stores stance', () => {
    const state = new PendingCritiqueState();
    state.register(7, { resolve: vi.fn(), reject: vi.fn(), timeoutMs: 10_000 });
    state.advanceToText(7, 'challenge');

    const pending = state.get(7);
    expect(pending!.phase).toBe('awaiting-text');
    expect(pending!.stance).toBe('challenge');
  });

  it('advanceToText() is a no-op if no pending critique', () => {
    const state = new PendingCritiqueState();
    expect(() => state.advanceToText(99, 'question')).not.toThrow();
    expect(state.get(99)).toBeUndefined();
  });

  it('resolveSkipped() resolves the promise as skipped and clears state', () => {
    const state = new PendingCritiqueState();
    const resolve = vi.fn<(r: CritiquePromptResult) => void>();
    state.register(5, { resolve, reject: vi.fn(), timeoutMs: 10_000 });

    state.resolveSkipped(5);
    expect(resolve).toHaveBeenCalledWith({ kind: 'skipped' });
    expect(state.get(5)).toBeUndefined();
  });

  it('resolveSubmitted() resolves the promise as submitted with stance+content and clears state', () => {
    const state = new PendingCritiqueState();
    const resolve = vi.fn<(r: CritiquePromptResult) => void>();
    state.register(5, { resolve, reject: vi.fn(), timeoutMs: 10_000 });
    state.advanceToText(5, 'addPremise');

    state.resolveSubmitted(5, 'cost assumption is wrong');
    expect(resolve).toHaveBeenCalledWith({
      kind: 'submitted',
      stance: 'addPremise',
      content: 'cost assumption is wrong',
    });
    expect(state.get(5)).toBeUndefined();
  });

  it('resolveSubmitted() is a no-op if not in awaiting-text phase', () => {
    const state = new PendingCritiqueState();
    const resolve = vi.fn();
    state.register(5, { resolve, reject: vi.fn(), timeoutMs: 10_000 });
    // Still awaiting-button — calling resolveSubmitted should not resolve
    state.resolveSubmitted(5, 'premature text');
    expect(resolve).not.toHaveBeenCalled();
    expect(state.get(5)).toBeDefined();
  });

  it('timeout fires resolveSkipped automatically after timeoutMs', () => {
    const state = new PendingCritiqueState();
    const resolve = vi.fn<(r: CritiquePromptResult) => void>();
    state.register(8, { resolve, reject: vi.fn(), timeoutMs: 30_000 });

    vi.advanceTimersByTime(29_999);
    expect(resolve).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(resolve).toHaveBeenCalledWith({ kind: 'skipped' });
    expect(state.get(8)).toBeUndefined();
  });

  it('resolving before timeout cancels the timer', () => {
    const state = new PendingCritiqueState();
    const resolve = vi.fn<(r: CritiquePromptResult) => void>();
    state.register(9, { resolve, reject: vi.fn(), timeoutMs: 30_000 });

    state.resolveSkipped(9);
    vi.advanceTimersByTime(60_000);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('exposes PendingCritique as a discriminated union narrowed by phase', () => {
    const state = new PendingCritiqueState();
    state.register(1, { resolve: vi.fn(), reject: vi.fn(), timeoutMs: 10_000 });
    const beforeText: PendingCritique | undefined = state.get(1);
    expect(beforeText).toEqual({ phase: 'awaiting-button' });
    // The awaiting-button variant has no `stance` field at all (it's excluded
    // from the union, not just undefined) — helps callers avoid reading a
    // meaningless field.
    if (beforeText && beforeText.phase === 'awaiting-button') {
      expect('stance' in beforeText).toBe(false);
    }

    state.advanceToText(1, 'question');
    const afterText: PendingCritique | undefined = state.get(1);
    expect(afterText).toEqual({ phase: 'awaiting-text', stance: 'question' });
  });

  it('drain() skips all pending critiques and clears state (for shutdown)', () => {
    const state = new PendingCritiqueState();
    const r1 = vi.fn();
    const r2 = vi.fn();
    state.register(10, { resolve: r1, reject: vi.fn(), timeoutMs: 10_000 });
    state.register(20, { resolve: r2, reject: vi.fn(), timeoutMs: 10_000 });
    state.advanceToText(20, 'addPremise');

    state.drain();

    expect(r1).toHaveBeenCalledWith({ kind: 'skipped' });
    expect(r2).toHaveBeenCalledWith({ kind: 'skipped' });
    expect(state.get(10)).toBeUndefined();
    expect(state.get(20)).toBeUndefined();

    // Timers should be cleared; advancing past original timeout shouldn't
    // trigger any extra resolves.
    vi.advanceTimersByTime(60_000);
    expect(r1).toHaveBeenCalledTimes(1);
    expect(r2).toHaveBeenCalledTimes(1);
  });
});
