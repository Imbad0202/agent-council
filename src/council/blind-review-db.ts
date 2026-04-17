import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class BlindReviewDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blind_review_sessions (
        session_id TEXT PRIMARY KEY,
        thread_id INTEGER NOT NULL,
        topic TEXT,
        -- agent_ids: JSON array of agent ID strings
        agent_ids TEXT NOT NULL DEFAULT '[]',
        started_at TEXT NOT NULL,
        revealed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS blind_review_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        tier TEXT NOT NULL,
        model TEXT NOT NULL,
        score INTEGER NOT NULL,
        feedback_text TEXT,
        scored_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES blind_review_sessions(session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_events_agent_tier
        ON blind_review_events(agent_id, tier);

      CREATE TABLE IF NOT EXISTS blind_review_stats (
        agent_id TEXT NOT NULL,
        tier TEXT NOT NULL,
        sample_count INTEGER NOT NULL,
        avg_score REAL NOT NULL,
        -- last_5_scores: JSON array of the most recent 5 scores (chronological)
        last_5_scores TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, tier)
      );
    `);
  }

  listTables(): string[] {
    return (this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[])
      .map((r) => r.name);
  }

  close(): void {
    this.db.close();
  }
}
