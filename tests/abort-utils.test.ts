import { describe, it, expect } from 'vitest';
import { TimeoutReason } from '../src/abort-utils.js';

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
