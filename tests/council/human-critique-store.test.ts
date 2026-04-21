import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { HumanCritiqueStore } from '../../src/council/human-critique-store.js';

describe('HumanCritiqueStore', () => {
  let store: HumanCritiqueStore;

  beforeEach(() => {
    store = new HumanCritiqueStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('open() returns a pending window visible via get()', () => {
    store.open(1, { prevAgent: 'huahua', nextAgent: 'binbin', timeoutMs: 10_000 });
    const pending = store.get(1);
    expect(pending).toBeDefined();
    expect(pending?.prevAgent).toBe('huahua');
    expect(pending?.nextAgent).toBe('binbin');
    expect(pending?.status).toBe('pending');
  });

  it('submit() resolves the window promise with a critique outcome', async () => {
    const promise = store.open(1, { prevAgent: 'a', nextAgent: 'b', timeoutMs: 10_000 });
    store.submit(1, { stance: 'challenge', content: 'ignored cost' });
    const outcome = await promise;
    expect(outcome.kind).toBe('submitted');
    if (outcome.kind === 'submitted') {
      expect(outcome.stance).toBe('challenge');
      expect(outcome.content).toBe('ignored cost');
    }
  });

  it('skip() resolves with skipped outcome', async () => {
    const promise = store.open(1, { prevAgent: 'a', nextAgent: 'b', timeoutMs: 10_000 });
    store.skip(1, 'user-skip');
    const outcome = await promise;
    expect(outcome.kind).toBe('skipped');
    if (outcome.kind === 'skipped') {
      expect(outcome.reason).toBe('user-skip');
    }
  });

  it('timeout automatically resolves with skipped outcome', async () => {
    vi.useFakeTimers();
    const promise = store.open(1, { prevAgent: 'a', nextAgent: 'b', timeoutMs: 5_000 });
    vi.advanceTimersByTime(5_001);
    const outcome = await promise;
    expect(outcome.kind).toBe('skipped');
    if (outcome.kind === 'skipped') {
      expect(outcome.reason).toBe('timeout');
    }
  });

  it('get() returns undefined after window resolves', async () => {
    const promise = store.open(1, { prevAgent: 'a', nextAgent: 'b', timeoutMs: 10_000 });
    store.submit(1, { stance: 'question', content: 'why?' });
    await promise;
    expect(store.get(1)).toBeUndefined();
  });

  it('open() rejects a second open on the same thread while one is pending', () => {
    store.open(1, { prevAgent: 'a', nextAgent: 'b', timeoutMs: 10_000 });
    expect(() =>
      store.open(1, { prevAgent: 'c', nextAgent: 'd', timeoutMs: 10_000 }),
    ).toThrow(/pending/i);
  });

  it('different threadIds have independent windows', async () => {
    const p1 = store.open(1, { prevAgent: 'a', nextAgent: 'b', timeoutMs: 10_000 });
    const p2 = store.open(2, { prevAgent: 'c', nextAgent: 'd', timeoutMs: 10_000 });
    store.submit(1, { stance: 'question', content: 'q1' });
    store.skip(2, 'user-skip');
    const [o1, o2] = await Promise.all([p1, p2]);
    expect(o1.kind).toBe('submitted');
    expect(o2.kind).toBe('skipped');
  });

  it('submit on a non-existent window is a no-op, not a throw', () => {
    expect(() =>
      store.submit(42, { stance: 'question', content: 'ghost' }),
    ).not.toThrow();
  });

  it('skip clears the timer so late-arriving timeout does not double-resolve', async () => {
    vi.useFakeTimers();
    const promise = store.open(1, { prevAgent: 'a', nextAgent: 'b', timeoutMs: 5_000 });
    store.skip(1, 'user-skip');
    vi.advanceTimersByTime(10_000);
    const outcome = await promise;
    expect(outcome.kind).toBe('skipped');
    if (outcome.kind === 'skipped') {
      expect(outcome.reason).toBe('user-skip');
    }
  });
});
