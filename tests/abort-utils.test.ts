import { describe, it, expect } from 'vitest';
import { TimeoutReason, isAbortError } from '../src/abort-utils.js';

describe('TimeoutReason', () => {
  it('extends Error with name "TimeoutReason"', () => {
    const r = new TimeoutReason(30_000);
    expect(r).toBeInstanceOf(Error);
    expect(r.name).toBe('TimeoutReason');
  });

  it('carries perAttemptMs', () => {
    const r = new TimeoutReason(30_000);
    expect(r.perAttemptMs).toBe(30_000);
  });

  it('message mentions the timeout duration', () => {
    const r = new TimeoutReason(45_000);
    expect(r.message).toContain('45000');
  });
});

describe('isAbortError', () => {
  it('recognizes DOM AbortError', () => {
    const err = new DOMException('aborted', 'AbortError');
    expect(isAbortError(err)).toBe(true);
  });

  it('recognizes errors with code ABORT_ERR', () => {
    const err = Object.assign(new Error('boom'), { code: 'ABORT_ERR' });
    expect(isAbortError(err)).toBe(true);
  });

  it('recognizes SDK APIUserAbortError by constructor name', () => {
    class APIUserAbortError extends Error {
      constructor() { super('user aborted'); }
    }
    expect(isAbortError(new APIUserAbortError())).toBe(true);
  });

  it('rejects plain Error', () => {
    expect(isAbortError(new Error('plain'))).toBe(false);
  });

  it('rejects null / undefined / non-objects', () => {
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError('string')).toBe(false);
    expect(isAbortError(42)).toBe(false);
  });

  it('rejects errors with unrelated name and code', () => {
    const err = Object.assign(new Error('boom'), { name: 'TimeoutError', code: 'ETIMEDOUT' });
    expect(isAbortError(err)).toBe(false);
  });
});
