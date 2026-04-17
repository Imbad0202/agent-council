// src/council/pvg-rotate.ts
import type { AdversarialRole } from './adversarial-provers.js';
import { InlineKeyboard } from 'grammy';
import type { PvgRotateStats } from './pvg-rotate-db.js';

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

const BUTTONS: Array<{ label: string; role: AdversarialRole }> = [
  { label: 'Sneaky', role: 'sneaky-prover' },
  { label: 'Biased', role: 'biased-prover' },
  { label: 'Deceptive', role: 'deceptive-prover' },
  { label: 'Calibrated (honest)', role: 'calibrated-prover' },
];

export const ROTATION_CALLBACK_PATTERN = /^pvg-rotate-guess:(sneaky-prover|biased-prover|deceptive-prover|calibrated-prover)$/;

export function buildRotationKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  BUTTONS.forEach(({ label, role }, i) => {
    if (i > 0 && i % 2 === 0) kb.row();
    kb.text(label, `pvg-rotate-guess:${role}`);
  });
  return kb;
}

export interface RevealInput {
  plantedRole: AdversarialRole;
  guessedRole: AdversarialRole;
  debriefLine: string;
  stats: PvgRotateStats;
}

export function formatGuessReveal(input: RevealInput): string {
  const { plantedRole, guessedRole, debriefLine, stats } = input;
  const hit = plantedRole === guessedRole;
  const lines: string[] = [];
  lines.push(hit ? '✅ Correct' : '❌ Miss');
  lines.push(`You guessed: ${shortName(guessedRole)}`);
  lines.push(`Actual: ${shortName(plantedRole)}`);
  lines.push('');
  lines.push(debriefLine);

  if (stats.total > 0) {
    lines.push('');
    const pct = Math.round((stats.correct / stats.total) * 100);
    lines.push(`Your verifier record: ${stats.correct} correct of ${stats.total} rounds (${pct}%)`);
    const weakest = findWeakestVector(stats);
    if (weakest) {
      const v = stats.perVector[weakest];
      lines.push(`Weakest spot: ${shortName(weakest)} (${v.hit}/${v.hit + v.miss})`);
    }
  }
  return lines.join('\n');
}

function shortName(role: AdversarialRole): string {
  return role.replace('-prover', '');
}

function findWeakestVector(stats: PvgRotateStats): AdversarialRole | null {
  let worst: AdversarialRole | null = null;
  let worstRate = Infinity;
  for (const role of ROTATION_ROLES) {
    const v = stats.perVector[role];
    const n = v.hit + v.miss;
    if (n === 0) continue;
    const rate = v.hit / n;
    if (rate < worstRate) {
      worstRate = rate;
      worst = role;
    }
  }
  return worst;
}
