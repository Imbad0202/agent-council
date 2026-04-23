import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ResetSnapshot } from '../types.js';

interface SnapshotRow {
  snapshot_id: string;
  thread_id: number;
  segment_index: number;
  sealed_at: string;
  summary_markdown: string;
  open_questions_count: number;
  decisions_count: number;
  blind_review_session_id: string | null;
}

function rowToRecord(row: SnapshotRow): ResetSnapshot {
  return {
    snapshotId: row.snapshot_id,
    threadId: row.thread_id,
    segmentIndex: row.segment_index,
    sealedAt: row.sealed_at,
    summaryMarkdown: row.summary_markdown,
    metadata: {
      openQuestionsCount: row.open_questions_count,
      decisionsCount: row.decisions_count,
      blindReviewSessionId: row.blind_review_session_id,
    },
  };
}

export class ResetSnapshotDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_reset_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        thread_id INTEGER NOT NULL,
        segment_index INTEGER NOT NULL,
        sealed_at TEXT NOT NULL,
        summary_markdown TEXT NOT NULL,
        open_questions_count INTEGER NOT NULL DEFAULT 0,
        decisions_count INTEGER NOT NULL DEFAULT 0,
        blind_review_session_id TEXT,
        UNIQUE (thread_id, segment_index)
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_thread_sealed
        ON session_reset_snapshots(thread_id, sealed_at DESC);
    `);
  }

  recordSnapshot(snap: ResetSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO session_reset_snapshots
           (snapshot_id, thread_id, segment_index, sealed_at, summary_markdown,
            open_questions_count, decisions_count, blind_review_session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snap.snapshotId,
        snap.threadId,
        snap.segmentIndex,
        snap.sealedAt,
        snap.summaryMarkdown,
        snap.metadata.openQuestionsCount,
        snap.metadata.decisionsCount,
        snap.metadata.blindReviewSessionId,
      );
  }

  getSnapshot(snapshotId: string): ResetSnapshot | null {
    const row = this.db
      .prepare(`SELECT * FROM session_reset_snapshots WHERE snapshot_id = ?`)
      .get(snapshotId) as SnapshotRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  // ORDER BY segment_index ASC is load-bearing:
  //   - DeliberationHandler.getSnapshotPrefix() (round-9 post-restart fallback)
  //     treats rows[rows.length - 1] as the newest snapshot
  //   - SessionReset.reset() takes max(segment_index) + 1 for the next index
  //     (round-6 restart-safe collision fix)
  //   - SessionReset builds the prior-summaries block in chronological order
  //     for the facilitator (round-8 multi-reset carry-forward)
  // Don't remove the ORDER BY clause without fixing those call sites.
  listSnapshotsForThread(threadId: number): ResetSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM session_reset_snapshots
           WHERE thread_id = ?
           ORDER BY segment_index ASC`,
      )
      .all(threadId) as SnapshotRow[];
    return rows.map(rowToRecord);
  }

  deleteSnapshot(snapshotId: string): void {
    this.db
      .prepare(`DELETE FROM session_reset_snapshots WHERE snapshot_id = ?`)
      .run(snapshotId);
  }

  listTables(): string[] {
    return (
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[]
    ).map((r) => r.name);
  }

  close(): void {
    this.db.close();
  }
}
