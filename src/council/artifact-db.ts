import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ArtifactRow {
  id: number;
  thread_id: number;
  segment_index: number;
  thread_local_seq: number;
  preset: 'universal' | 'decision';
  content_md: string;
  created_at: string;
  synthesis_model: string | null;
  synthesis_token_usage_json: string | null;
}

export interface ArtifactInsertInput {
  thread_id: number;
  segment_index: number;
  thread_local_seq: number;
  preset: 'universal' | 'decision';
  content_md: string;
  created_at: string;
  synthesis_model?: string | null;
  synthesis_token_usage_json?: string | null;
}

export class ArtifactDB {
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
      CREATE TABLE IF NOT EXISTS council_artifacts (
        id                          INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id                   INTEGER NOT NULL,
        segment_index               INTEGER NOT NULL,
        thread_local_seq            INTEGER NOT NULL,
        preset                      TEXT NOT NULL,
        content_md                  TEXT NOT NULL,
        created_at                  TEXT NOT NULL,
        synthesis_model             TEXT,
        synthesis_token_usage_json  TEXT,
        UNIQUE(thread_id, segment_index),
        UNIQUE(thread_id, thread_local_seq)
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_thread
        ON council_artifacts(thread_id, created_at DESC);
    `);
  }

  insert(input: ArtifactInsertInput): ArtifactRow {
    const result = this.db
      .prepare(
        `INSERT INTO council_artifacts
           (thread_id, segment_index, thread_local_seq, preset, content_md, created_at, synthesis_model, synthesis_token_usage_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.thread_id, input.segment_index, input.thread_local_seq,
        input.preset, input.content_md, input.created_at,
        input.synthesis_model ?? null, input.synthesis_token_usage_json ?? null,
      );
    const id = Number(result.lastInsertRowid);
    return this.fetchById(id)!;
  }

  /**
   * Returns LATEST artifact for (thread_id, preset) ordered by segment_index DESC.
   * Latest-by-segment_index is contractually required for cache invalidation in
   * ArtifactService fast-path (Task 11) -- older rows must NEVER be returned.
   */
  findByThreadPreset(threadId: number, preset: 'universal' | 'decision'): ArtifactRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM council_artifacts
         WHERE thread_id = ? AND preset = ?
         ORDER BY segment_index DESC
         LIMIT 1`,
      )
      .get(threadId, preset) as ArtifactRow | undefined;
    return row ?? null;
  }

  findByThread(threadId: number): ArtifactRow[] {
    return this.db
      .prepare(`SELECT * FROM council_artifacts WHERE thread_id = ? ORDER BY segment_index ASC`)
      .all(threadId) as ArtifactRow[];
  }

  maxThreadLocalSeq(threadId: number): number | null {
    const row = this.db
      .prepare(`SELECT MAX(thread_local_seq) AS m FROM council_artifacts WHERE thread_id = ?`)
      .get(threadId) as { m: number | null } | undefined;
    return row?.m ?? null;
  }

  deleteById(id: number): void {
    this.db.prepare(`DELETE FROM council_artifacts WHERE id = ?`).run(id);
  }

  fetchById(id: number): ArtifactRow | null {
    const row = this.db
      .prepare(`SELECT * FROM council_artifacts WHERE id = ?`)
      .get(id) as ArtifactRow | undefined;
    return row ?? null;
  }

  fetchByThreadLocalSeq(threadId: number, seq: number): ArtifactRow | null {
    const row = this.db
      .prepare(`SELECT * FROM council_artifacts WHERE thread_id = ? AND thread_local_seq = ?`)
      .get(threadId, seq) as ArtifactRow | undefined;
    return row ?? null;
  }

  close(): void {
    this.db.close();
  }
}
