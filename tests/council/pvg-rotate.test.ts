// tests/council/pvg-rotate.test.ts
import { describe, it, expect } from 'vitest';
import { pickRandomAdversarialRole } from '../../src/council/pvg-rotate.js';
import { PvgRotateStore } from '../../src/council/pvg-rotate-store.js';

describe('pickRandomAdversarialRole', () => {
  it('returns all four adversarial roles given rng sweep', () => {
    expect(pickRandomAdversarialRole(() => 0.0)).toBe('sneaky-prover');
    expect(pickRandomAdversarialRole(() => 0.25)).toBe('biased-prover');
    expect(pickRandomAdversarialRole(() => 0.5)).toBe('deceptive-prover');
    expect(pickRandomAdversarialRole(() => 0.999)).toBe('calibrated-prover');
  });

  it('clamps rng >= 1 to the last role', () => {
    expect(pickRandomAdversarialRole(() => 1.0)).toBe('calibrated-prover');
  });
});

describe('PvgRotateStore', () => {
  it('creates a session with the planted role', () => {
    const store = new PvgRotateStore();
    const session = store.create(42, 'biased-prover');
    expect('error' in session).toBe(false);
    if ('error' in session) return;
    expect(session.plantedRole).toBe('biased-prover');
    expect(session.threadId).toBe(42);
    expect(session.guessedRole).toBeUndefined();
  });

  it('refuses to create a second pending session for the same thread', () => {
    const store = new PvgRotateStore();
    store.create(42, 'biased-prover');
    const second = store.create(42, 'sneaky-prover');
    expect('error' in second).toBe(true);
  });

  it('recordGuess returns correct=true on match', () => {
    const store = new PvgRotateStore();
    store.create(42, 'biased-prover');
    const hit = store.recordGuess(42, 'biased-prover');
    if ('error' in hit) throw new Error('unexpected error');
    expect(hit.correct).toBe(true);
    expect(hit.plantedRole).toBe('biased-prover');
  });

  it('recordGuess returns correct=false on miss', () => {
    const store = new PvgRotateStore();
    store.create(42, 'biased-prover');
    const miss = store.recordGuess(42, 'sneaky-prover');
    if ('error' in miss) throw new Error('unexpected error');
    expect(miss.correct).toBe(false);
  });

  it('recordGuess twice returns already-guessed error', () => {
    const store = new PvgRotateStore();
    store.create(42, 'biased-prover');
    store.recordGuess(42, 'biased-prover');
    const second = store.recordGuess(42, 'sneaky-prover');
    expect('error' in second).toBe(true);
  });

  it('recordGuess with no session returns error', () => {
    const store = new PvgRotateStore();
    const result = store.recordGuess(42, 'biased-prover');
    expect('error' in result).toBe(true);
  });

  it('delete removes the session', () => {
    const store = new PvgRotateStore();
    store.create(42, 'biased-prover');
    store.delete(42);
    expect(store.get(42)).toBeUndefined();
  });

  it('attachDebrief stores the debrief on the session', () => {
    const store = new PvgRotateStore();
    store.create(42, 'biased-prover');
    store.attachDebrief(42, {
      role: 'biased-prover',
      agentId: 'a1',
      kind: 'anchoring',
      debrief: 'anchored on first estimate',
    });
    expect(store.get(42)?.plantedDebrief?.kind).toBe('anchoring');
  });
});
