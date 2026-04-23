import { describe, it, expect } from 'vitest';
import { BlindReviewStore } from '../../src/council/blind-review.js';

describe('BlindReviewStore.create return shape', () => {
  it('returns sessionId on success', () => {
    const store = new BlindReviewStore();
    const result = store.create(42, ['a', 'b'], new Map());
    expect('sessionId' in result).toBe(true);
    if ('sessionId' in result) {
      expect(result.sessionId).toMatch(/^42:\d+$/);
    }
  });

  it('error result has no sessionId field', () => {
    const store = new BlindReviewStore();
    store.create(42, ['a', 'b'], new Map());
    const second = store.create(42, ['a', 'b'], new Map());
    expect('error' in second).toBe(true);
    if ('error' in second) {
      expect(second.sessionId).toBeUndefined();
    }
  });

  it('sessionId matches the format used by BlindReviewDB persistence', () => {
    const store = new BlindReviewStore();
    const result = store.create(42, ['a', 'b'], new Map());
    if ('sessionId' in result) {
      const [threadPart, tsPart] = result.sessionId.split(':');
      expect(threadPart).toBe('42');
      expect(Number.parseInt(tsPart, 10)).toBeGreaterThan(0);
    }
  });
});
