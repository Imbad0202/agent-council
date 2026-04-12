import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MemoryRecord, PatternRecord } from '../types.js';

type MemoryType = MemoryRecord['type'];

interface MemoryRow {
  id: string;
  agent_id: string;
  type: string;
  topic: string | null;
  confidence: number;
  outcome: string | null;
  usage_count: number;
  last_used: string | null;
  created_at: string;
  content_preview: string;
}

interface PatternRow {
  id: number;
  agent_id: string;
  topic: string;
  behavior: string;
  extracted_from: string;
  created_at: string;
}

function rowToRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    type: row.type as MemoryType,
    topic: row.topic,
    confidence: row.confidence,
    outcome: row.outcome as MemoryRecord['outcome'],
    usageCount: row.usage_count,
    lastUsed: row.last_used,
    createdAt: row.created_at,
    contentPreview: row.content_preview,
  };
}

function patternRowToRecord(row: PatternRow): PatternRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    topic: row.topic,
    behavior: row.behavior,
    extractedFrom: row.extracted_from,
    createdAt: row.created_at,
  };
}

export class MemoryDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        type TEXT NOT NULL,
        topic TEXT,
        confidence REAL DEFAULT 0.7,
        outcome TEXT,
        usage_count INTEGER DEFAULT 0,
        last_used TEXT,
        created_at TEXT NOT NULL,
        content_preview TEXT
      );

      CREATE TABLE IF NOT EXISTS patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        behavior TEXT NOT NULL,
        extracted_from TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    // FTS5 virtual table — created separately since CREATE VIRTUAL TABLE
    // doesn't support IF NOT EXISTS in all builds, so we check first.
    const ftsExists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'")
      .get();

    if (!ftsExists) {
      this.db.exec(`
        CREATE VIRTUAL TABLE memories_fts USING fts5(
          id, topic, content_preview
        );
      `);
    }
  }

  listTables(): string[] {
    const rows = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual') ORDER BY name")
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  insertMemory(record: MemoryRecord): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memories (id, agent_id, type, topic, confidence, outcome, usage_count, last_used, created_at, content_preview)
      VALUES (@id, @agent_id, @type, @topic, @confidence, @outcome, @usage_count, @last_used, @created_at, @content_preview)
    `);

    stmt.run({
      id: record.id,
      agent_id: record.agentId,
      type: record.type,
      topic: record.topic,
      confidence: record.confidence,
      outcome: record.outcome,
      usage_count: record.usageCount,
      last_used: record.lastUsed,
      created_at: record.createdAt,
      content_preview: record.contentPreview,
    });

    // Update FTS5 index: delete old entry if exists, then insert new
    this.db.prepare('DELETE FROM memories_fts WHERE id = ?').run(record.id);
    this.db
      .prepare('INSERT INTO memories_fts (id, topic, content_preview) VALUES (?, ?, ?)')
      .run(record.id, record.topic, record.contentPreview);
  }

  getMemory(id: string): MemoryRecord | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  searchMemories(query: string): MemoryRecord[] {
    try {
      // Try FTS5 search first
      const ftsRows = this.db
        .prepare(
          `SELECT m.* FROM memories m
           JOIN memories_fts fts ON m.id = fts.id
           WHERE memories_fts MATCH ?
           ORDER BY m.usage_count DESC`
        )
        .all(query) as MemoryRow[];
      return ftsRows.map(rowToRecord);
    } catch {
      // Fallback to LIKE if FTS5 unavailable
      const likePattern = `%${query}%`;
      const rows = this.db
        .prepare(
          `SELECT * FROM memories
           WHERE topic LIKE ? OR content_preview LIKE ?
           ORDER BY usage_count DESC`
        )
        .all(likePattern, likePattern) as MemoryRow[];
      return rows.map(rowToRecord);
    }
  }

  incrementUsage(id: string, date: string): void {
    this.db
      .prepare('UPDATE memories SET usage_count = usage_count + 1, last_used = ? WHERE id = ?')
      .run(date, id);
  }

  updateType(id: string, type: MemoryType): void {
    this.db.prepare('UPDATE memories SET type = ? WHERE id = ?').run(type, id);
  }

  listAllMemoriesByType(type: MemoryType): MemoryRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM memories WHERE type = ? ORDER BY confidence DESC, usage_count DESC')
      .all(type) as MemoryRow[];
    return rows.map(rowToRecord);
  }

  listMemories(agentId: string, type?: MemoryType): MemoryRecord[] {
    if (type) {
      const rows = this.db
        .prepare('SELECT * FROM memories WHERE agent_id = ? AND type = ? ORDER BY usage_count DESC')
        .all(agentId, type) as MemoryRow[];
      return rows.map(rowToRecord);
    }

    // When type is omitted, exclude archive
    const rows = this.db
      .prepare("SELECT * FROM memories WHERE agent_id = ? AND type != 'archive' ORDER BY usage_count DESC")
      .all(agentId) as MemoryRow[];
    return rows.map(rowToRecord);
  }

  countActiveMemories(agentId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM memories WHERE agent_id = ? AND type != 'archive'")
      .get(agentId) as { count: number };
    return row.count;
  }

  getMemoriesByTopic(agentId: string, topic: string, type?: MemoryType): MemoryRecord[] {
    if (type) {
      const rows = this.db
        .prepare('SELECT * FROM memories WHERE agent_id = ? AND topic = ? AND type = ? ORDER BY usage_count DESC')
        .all(agentId, topic, type) as MemoryRow[];
      return rows.map(rowToRecord);
    }

    const rows = this.db
      .prepare('SELECT * FROM memories WHERE agent_id = ? AND topic = ? ORDER BY usage_count DESC')
      .all(agentId, topic) as MemoryRow[];
    return rows.map(rowToRecord);
  }

  getLowestScoredMemories(agentId: string, percent: number): MemoryRecord[] {
    // Retrieval score: usage_count * (1.0 / (1.0 + days_since_last_used / 7.0))
    // days_since_last_used = julianday('now') - julianday(last_used)
    // If last_used is NULL, treat as very old (score near 0)
    const rows = this.db
      .prepare(
        `SELECT *,
           usage_count * (1.0 / (1.0 + COALESCE(julianday('now') - julianday(last_used), 365) / 7.0)) AS score
         FROM memories
         WHERE agent_id = ? AND type != 'archive'
         ORDER BY score ASC`
      )
      .all(agentId) as MemoryRow[];

    const n = Math.max(1, Math.floor(rows.length * percent / 100));
    return rows.slice(0, n).map(rowToRecord);
  }

  insertPattern(pattern: Omit<PatternRecord, 'id' | 'createdAt'>): void {
    this.db
      .prepare(
        `INSERT INTO patterns (agent_id, topic, behavior, extracted_from, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(pattern.agentId, pattern.topic, pattern.behavior, pattern.extractedFrom, new Date().toISOString().slice(0, 10));
  }

  getPatterns(agentId: string, topic?: string): PatternRecord[] {
    if (topic) {
      const rows = this.db
        .prepare('SELECT * FROM patterns WHERE agent_id = ? AND topic = ? ORDER BY created_at DESC')
        .all(agentId, topic) as PatternRow[];
      return rows.map(patternRowToRecord);
    }

    const rows = this.db
      .prepare('SELECT * FROM patterns WHERE agent_id = ? ORDER BY created_at DESC')
      .all(agentId) as PatternRow[];
    return rows.map(patternRowToRecord);
  }

  close(): void {
    this.db.close();
  }
}
