import { describe, it, expect } from 'vitest';
import {
  BlindReviewActiveError,
  DeliberationInProgressError,
  ResetInProgressError,
} from '../../src/council/session-reset-errors.js';

describe('BlindReviewActiveError', () => {
  it('is an Error subclass with a user-facing message', () => {
    const err = new BlindReviewActiveError();
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('/blindreview reveal');
    expect(err.message).toContain('/cancelreview');
    expect(err.name).toBe('BlindReviewActiveError');
  });
});

describe('ResetInProgressError', () => {
  it('names the thread id and sets name for instanceof branching', () => {
    const err = new ResetInProgressError(42);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('42');
    expect(err.name).toBe('ResetInProgressError');
  });
});

describe('DeliberationInProgressError', () => {
  it('names the thread id and sets name for instanceof branching', () => {
    const err = new DeliberationInProgressError(99);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('99');
    expect(err.message).toContain('deliberation');
    expect(err.name).toBe('DeliberationInProgressError');
  });
});
