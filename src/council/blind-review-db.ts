import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  AgentTier,
  BlindReviewSessionRow,
  BlindReviewEventInput,
} from '../types.js';

interface SessionRow {
  session_id: string;
  thread_id: number;
  topic: string | null;
  agent_ids: string;
  started_at: string;
  revealed_at: string | null;
}

interface EventRow {
  event_id: number;
  session_id: string;
  agent_id: string;
  tier: string;
  model: string;
  score: number;
  feedback_text: string | null;
  scored_at: string;
}

export interface BlindReviewEventRecord {
  eventId: number;
  sessionId: string;
  agentId: string;
  tier: AgentTier;
  model: string;
  score: number;
  feedbackText: string | null;
  scoredAt: string;
}

function sessionRowToRecord(row: SessionRow): BlindReviewSessionRow {
  return {
    sessionId: row.session_id,
    threadId: row.thread_id,
    topic: row.topic,
    agentIds: JSON.parse(row.agent_ids) as string[],
    startedAt: row.started_at,
    revealedAt: row.revealed_at,
  };
}

function eventRowToRecord(row: EventRow): BlindReviewEventRecord {
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    tier: row.tier as AgentTier,
    model: row.model,
    score: row.score,
    feedbackText: row.feedback_text,
    scoredAt: row.scored_at,
  };
}

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

  recordSession(row: BlindReviewSessionRow): void {
    this.db.prepare(
      `INSERT INTO blind_review_sessions
         (session_id, thread_id, topic, agent_ids, started_at, revealed_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      row.sessionId,
      row.threadId,
      row.topic,
      JSON.stringify(row.agentIds),
      row.startedAt,
      row.revealedAt,
    );
  }

  getSession(sessionId: string): BlindReviewSessionRow | null {
    const row = this.db.prepare(
      `SELECT * FROM blind_review_sessions WHERE session_id = ?`
    ).get(sessionId) as SessionRow | undefined;
    return row ? sessionRowToRecord(row) : null;
  }

  recordScore(input: BlindReviewEventInput): void {
    this.db.prepare(
      `INSERT INTO blind_review_events
         (session_id, agent_id, tier, model, score, feedback_text, scored_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.sessionId,
      input.agentId,
      input.tier,
      input.model,
      input.score,
      input.feedbackText ?? null,
      new Date().toISOString(),
    );
  }

  getEventsForSession(sessionId: string): BlindReviewEventRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM blind_review_events WHERE session_id = ? ORDER BY event_id ASC`
    ).all(sessionId) as EventRow[];
    return rows.map(eventRowToRecord);
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
