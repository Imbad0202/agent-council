// tests/council/pvg-rotate.test.ts
import { describe, it, expect } from 'vitest';
import { pickRandomAdversarialRole } from '../../src/council/pvg-rotate.js';

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
