// src/council/pvg-rotate.ts
import type { AdversarialRole } from './adversarial-provers.js';

const ROTATION_ROLES: AdversarialRole[] = [
  'sneaky-prover',
  'biased-prover',
  'deceptive-prover',
  'calibrated-prover',
];

export function pickRandomAdversarialRole(
  rng: () => number = Math.random,
): AdversarialRole {
  const idx = Math.floor(rng() * ROTATION_ROLES.length);
  return ROTATION_ROLES[Math.min(idx, ROTATION_ROLES.length - 1)];
}
