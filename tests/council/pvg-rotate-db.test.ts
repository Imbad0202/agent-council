import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PvgRotateDB } from '../../src/council/pvg-rotate-db.js';

describe('PvgRotateDB', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pvg-rotate-db-'));
    dbPath = join(dir, 'test.db');
  });

  it('records a guess and retrieves stats', () => {
    const db = new PvgRotateDB(dbPath);
    db.recordGuess({
      roundId: 'r1',
      threadId: 42,
      plantedRole: 'biased-prover',
      guessedRole: 'biased-prover',
      startedAt: new Date(1712900000000).toISOString(),
      guessedAt: new Date(1712900100000).toISOString(),
    });
    const stats = db.getStats(42);
    expect(stats.total).toBe(1);
    expect(stats.correct).toBe(1);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('aggregates multiple rounds: total/correct and per-vector hit/miss', () => {
    const db = new PvgRotateDB(dbPath);
    const now = Date.now();
    const rows = [
      ['r1', 'biased-prover', 'biased-prover'],
      ['r2', 'deceptive-prover', 'biased-prover'],
      ['r3', 'deceptive-prover', 'sneaky-prover'],
      ['r4', 'sneaky-prover', 'sneaky-prover'],
    ] as const;
    for (const [id, planted, guessed] of rows) {
      db.recordGuess({
        roundId: id,
        threadId: 42,
        plantedRole: planted,
        guessedRole: guessed,
        startedAt: new Date(now).toISOString(),
        guessedAt: new Date(now + 1000).toISOString(),
      });
    }
    const stats = db.getStats(42);
    expect(stats.total).toBe(4);
    expect(stats.correct).toBe(2);
    expect(stats.perVector['biased-prover']).toEqual({ hit: 1, miss: 0 });
    expect(stats.perVector['deceptive-prover']).toEqual({ hit: 0, miss: 2 });
    expect(stats.perVector['sneaky-prover']).toEqual({ hit: 1, miss: 0 });
    expect(stats.perVector['calibrated-prover']).toEqual({ hit: 0, miss: 0 });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('getStats returns zeros for unknown thread', () => {
    const db = new PvgRotateDB(dbPath);
    const stats = db.getStats(999);
    expect(stats.total).toBe(0);
    expect(stats.correct).toBe(0);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
