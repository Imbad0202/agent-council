import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AdversarialRole } from './adversarial-provers.js';

export interface PvgRotateRoundInput {
  roundId: string;
  threadId: number;
  plantedRole: AdversarialRole;
  guessedRole: AdversarialRole;
  startedAt: string;
  guessedAt: string;
}

export interface VectorStats {
  hit: number;
  miss: number;
}

export interface PvgRotateStats {
  total: number;
  correct: number;
  perVector: Record<AdversarialRole, VectorStats>;
}

const ALL_ROLES: AdversarialRole[] = [
  'sneaky-prover',
  'biased-prover',
  'deceptive-prover',
  'calibrated-prover',
];

export class PvgRotateDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pvg_rotate_rounds (
        round_id     TEXT PRIMARY KEY,
        thread_id    INTEGER NOT NULL,
        planted_role TEXT NOT NULL,
        guessed_role TEXT NOT NULL,
        correct      INTEGER NOT NULL,
        started_at   TEXT NOT NULL,
        guessed_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pvg_rounds_thread
        ON pvg_rotate_rounds(thread_id);
    `);
  }

  recordGuess(input: PvgRotateRoundInput): void {
    const correct = input.plantedRole === input.guessedRole ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO pvg_rotate_rounds
           (round_id, thread_id, planted_role, guessed_role, correct, started_at, guessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.roundId,
        input.threadId,
        input.plantedRole,
        input.guessedRole,
        correct,
        input.startedAt,
        input.guessedAt,
      );
  }

  getStats(threadId: number): PvgRotateStats {
    const rows = this.db
      .prepare(
        `SELECT planted_role, guessed_role, correct
           FROM pvg_rotate_rounds
          WHERE thread_id = ?`,
      )
      .all(threadId) as Array<{
        planted_role: string;
        guessed_role: string;
        correct: number;
      }>;

    const perVector: Record<AdversarialRole, VectorStats> = {
      'sneaky-prover': { hit: 0, miss: 0 },
      'biased-prover': { hit: 0, miss: 0 },
      'deceptive-prover': { hit: 0, miss: 0 },
      'calibrated-prover': { hit: 0, miss: 0 },
    };

    let correctCount = 0;
    for (const row of rows) {
      if (!ALL_ROLES.includes(row.planted_role as AdversarialRole)) continue;
      const planted = row.planted_role as AdversarialRole;
      if (row.correct === 1) {
        perVector[planted].hit += 1;
        correctCount += 1;
      } else {
        perVector[planted].miss += 1;
      }
    }
    return { total: rows.length, correct: correctCount, perVector };
  }

  close(): void {
    this.db.close();
  }
}
