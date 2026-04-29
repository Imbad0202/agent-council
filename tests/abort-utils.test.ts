import { describe, it, expect } from 'vitest';
import { TimeoutReason, isAbortError, mergeSignals, isTimeoutAbort } from '../src/abort-utils.js';

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

describe('mergeSignals', () => {
  it('returns undefined when all inputs undefined', () => {
    expect(mergeSignals(undefined, undefined)).toBeUndefined();
  });

  it('returns the single signal when only one provided', () => {
    const ctrl = new AbortController();
    const merged = mergeSignals(ctrl.signal, undefined);
    expect(merged).toBe(ctrl.signal);
  });

  it('returns AbortSignal.any composite when multiple provided', () => {
    const a = new AbortController();
    const b = new AbortController();
    const merged = mergeSignals(a.signal, b.signal);
    expect(merged).toBeDefined();
    expect(merged).not.toBe(a.signal);
    expect(merged).not.toBe(b.signal);
    expect(merged!.aborted).toBe(false);

    a.abort(new TimeoutReason(100));
    expect(merged!.aborted).toBe(true);
    expect(merged!.reason).toBeInstanceOf(TimeoutReason);
  });

  it('filters out undefined inputs', () => {
    const ctrl = new AbortController();
    const merged = mergeSignals(undefined, ctrl.signal, undefined);
    expect(merged).toBe(ctrl.signal);
  });
});

describe('isTimeoutAbort', () => {
  it('returns true when signal is aborted with TimeoutReason', () => {
    const ctrl = new AbortController();
    ctrl.abort(new TimeoutReason(100));
    expect(isTimeoutAbort(ctrl.signal)).toBe(true);
  });

  it('returns false when signal not aborted', () => {
    const ctrl = new AbortController();
    expect(isTimeoutAbort(ctrl.signal)).toBe(false);
  });

  it('returns false when aborted with non-Timeout reason', () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('user cancelled'));
    expect(isTimeoutAbort(ctrl.signal)).toBe(false);
  });
});
