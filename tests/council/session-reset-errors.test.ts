import { describe, it, expect } from 'vitest';
import { BlindReviewActiveError } from '../../src/council/session-reset-errors.js';

describe('BlindReviewActiveError', () => {
  it('is an Error subclass with a user-facing message', () => {
    const err = new BlindReviewActiveError();
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('/blindreview reveal');
    expect(err.message).toContain('/cancelreview');
    expect(err.name).toBe('BlindReviewActiveError');
  });
});
