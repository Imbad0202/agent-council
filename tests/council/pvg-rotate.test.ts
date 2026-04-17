// tests/council/pvg-rotate.test.ts
import { describe, it, expect } from 'vitest';
import { pickRandomAdversarialRole } from '../../src/council/pvg-rotate.js';
import { PvgRotateStore } from '../../src/council/pvg-rotate-store.js';
import {
  buildRotationKeyboard,
  formatGuessReveal,
  ROTATION_CALLBACK_PATTERN,
} from '../../src/council/pvg-rotate.js';

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

describe('buildRotationKeyboard', () => {
  it('builds 4 buttons with correct callback data', () => {
    const kb = buildRotationKeyboard();
    const json = JSON.parse(JSON.stringify(kb));
    const rows: Array<Array<{ text: string; callback_data: string }>> = json.inline_keyboard;
    const flat = rows.flat();
    expect(flat).toHaveLength(4);
    const callbackData = flat.map((b) => b.callback_data);
    expect(callbackData).toEqual([
      'pvg-rotate-guess:sneaky-prover',
      'pvg-rotate-guess:biased-prover',
      'pvg-rotate-guess:deceptive-prover',
      'pvg-rotate-guess:calibrated-prover',
    ]);
    expect(flat[3].text.toLowerCase()).toContain('honest');
  });

  it('ROTATION_CALLBACK_PATTERN matches generated data', () => {
    const m = 'pvg-rotate-guess:biased-prover'.match(ROTATION_CALLBACK_PATTERN);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('biased-prover');
  });
});

describe('formatGuessReveal', () => {
  const emptyStats = {
    total: 0,
    correct: 0,
    perVector: {
      'sneaky-prover': { hit: 0, miss: 0 },
      'biased-prover': { hit: 0, miss: 0 },
      'deceptive-prover': { hit: 0, miss: 0 },
      'calibrated-prover': { hit: 0, miss: 0 },
    },
  };

  it('renders a hit message with stats', () => {
    const msg = formatGuessReveal({
      plantedRole: 'biased-prover',
      guessedRole: 'biased-prover',
      debriefLine: '🎯 [BIASED DEBRIEF] agent-x framed with anchoring bias: anchored on first estimate',
      stats: {
        total: 3,
        correct: 2,
        perVector: {
          'sneaky-prover': { hit: 1, miss: 0 },
          'biased-prover': { hit: 1, miss: 0 },
          'deceptive-prover': { hit: 0, miss: 1 },
          'calibrated-prover': { hit: 0, miss: 0 },
        },
      },
    });
    expect(msg).toContain('✅');
    expect(msg).toContain('2 correct of 3');
    expect(msg).toContain('anchoring');
  });

  it('renders a miss message and flags the weakest vector', () => {
    const msg = formatGuessReveal({
      plantedRole: 'deceptive-prover',
      guessedRole: 'biased-prover',
      debriefLine: '🎭 [DECEPTIVE DEBRIEF] agent-y conclusion-evidence mismatch: overstated 8% effect',
      stats: {
        total: 4,
        correct: 1,
        perVector: {
          'sneaky-prover': { hit: 1, miss: 0 },
          'biased-prover': { hit: 0, miss: 1 },
          'deceptive-prover': { hit: 0, miss: 2 },
          'calibrated-prover': { hit: 0, miss: 0 },
        },
      },
    });
    expect(msg).toContain('❌');
    expect(msg).toContain('deceptive');
    expect(msg.toLowerCase()).toContain('weakest');
  });

  it('omits stats block when total=0 (first round)', () => {
    const msg = formatGuessReveal({
      plantedRole: 'sneaky-prover',
      guessedRole: 'sneaky-prover',
      debriefLine: '🔒 [SNEAKY DEBRIEF] agent-z planted logical-fallacy: false dichotomy',
      stats: emptyStats,
    });
    expect(msg).not.toMatch(/correct of/);
  });
});
