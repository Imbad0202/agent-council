# Blind-Review → Model Routing Closed Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist `/blindreview` scores to a new `data/council.db` with audit trail and per-(agent, tier) stats, then extend the reveal message to show historical trend + a rule-based routing recommendation.

**Architecture:** New `BlindReviewDB` class (pattern-matched to existing `MemoryDB`) manages 3 SQLite tables in a separate DB file. `BlindReviewStore.markRevealed()` flushes the session to DB in a transaction, tagged with per-turn `(tier, model)` captured during deliberation. `formatRevealMessage()` reads stats and composes a template-based recommendation per agent.

**Tech Stack:** TypeScript, better-sqlite3 (already used by MemoryDB), vitest, grammY (unchanged for inline keyboard).

**Spec:** `docs/superpowers/specs/2026-04-17-blind-review-routing-loop-design.md`

---

## File Structure

**New files:**
- `src/council/blind-review-db.ts` — `BlindReviewDB` class, schema, CRUD, `buildRecommendation`, `renderSparkline`
- `tests/council/blind-review-db.test.ts` — unit tests for `BlindReviewDB`

**Modified files:**
- `src/types.ts` — add `AgentTier` alias; extend `ProviderResponse` with `tierUsed` / `modelUsed`; add BlindReview row/input/stats types
- `src/worker/agent-worker.ts` — have `respond()` return `tierUsed` + `modelUsed` in the response
- `src/council/deliberation.ts` — propagate tier/model from worker response into the blind-review session when `blindReview=true`
- `src/council/blind-review.ts` — extend `BlindReviewSession` with `turnLog` + `feedbackText`; extend `formatRevealMessage()` to call DB and render recommendations
- `src/events/bus.ts` — add `blind-review.persist-failed` event
- `tests/council/blind-review.test.ts` — integration tests for persistence + reveal rendering
- `src/index.ts` — wire `BlindReviewDB` and hook persist-failed to event bus
- `CHANGELOG.md` — `[Unreleased]` entry

**Not modified in this plan:** `BlindReviewStore.create()` / `recordScore()` signatures (backward-compatible). `AgentWorker` callers outside deliberation (facilitator, executor) are unaffected since the new response fields are optional.

---

## Task 1: Scaffold BlindReviewDB skeleton with empty schema migration

**Files:**
- Create: `src/council/blind-review-db.ts`
- Create: `tests/council/blind-review-db.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/council/blind-review-db.test.ts
import { describe, it, expect } from 'vitest';
import { BlindReviewDB } from '../../src/council/blind-review-db.js';

describe('BlindReviewDB constructor', () => {
  it('creates a DB and migrates schema with 3 tables', () => {
    const db = new BlindReviewDB(':memory:');
    const tables = db.listTables();
    expect(tables).toContain('blind_review_sessions');
    expect(tables).toContain('blind_review_events');
    expect(tables).toContain('blind_review_stats');
  });

  it('is idempotent across re-instantiation', () => {
    const db1 = new BlindReviewDB(':memory:');
    expect(() => new BlindReviewDB(':memory:')).not.toThrow();
    db1.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/council/blind-review-db.test.ts`
Expected: FAIL with "Cannot find module '../../src/council/blind-review-db.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/council/blind-review-db.ts
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
        agent_ids TEXT NOT NULL,
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
        last_5_scores TEXT NOT NULL,
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/council/blind-review-db.test.ts`
Expected: PASS — 2 tests

- [ ] **Step 5: Commit**

```bash
git add src/council/blind-review-db.ts tests/council/blind-review-db.test.ts
git commit -m "feat(blind-review): scaffold BlindReviewDB with 3-table schema"
```

---

## Task 2: Add AgentTier alias + BlindReview row/input/stats types

**Files:**
- Modify: `src/types.ts`
- Modify: `tests/council/blind-review-db.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/council/blind-review-db.test.ts — extend
import type { BlindReviewSessionRow, BlindReviewEventInput, AgentTier } from '../../src/types.js';

describe('BlindReview types', () => {
  it('AgentTier accepts low/medium/high/unknown', () => {
    const tiers: AgentTier[] = ['low', 'medium', 'high', 'unknown'];
    expect(tiers).toHaveLength(4);
  });

  it('BlindReviewEventInput has required fields', () => {
    const input: BlindReviewEventInput = {
      sessionId: 's1',
      agentId: 'a1',
      tier: 'high',
      model: 'claude-opus-4-7',
      score: 4,
    };
    expect(input.feedbackText).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/council/blind-review-db.test.ts`
Expected: FAIL with TypeScript error "has no exported member 'AgentTier'"

- [ ] **Step 3: Write minimal implementation**

Add to `src/types.ts` after the existing `Complexity` type (line 4):

```typescript
export type AgentTier = Complexity | 'unknown';

export interface BlindReviewSessionRow {
  sessionId: string;
  threadId: number;
  topic: string | null;
  agentIds: string[];
  startedAt: string;
  revealedAt: string | null;
}

export interface BlindReviewEventInput {
  sessionId: string;
  agentId: string;
  tier: AgentTier;
  model: string;
  score: number;
  feedbackText?: string;
}

export interface AgentTierStats {
  agentId: string;
  tier: AgentTier;
  sampleCount: number;
  avgScore: number;
  last5Scores: number[];
  updatedAt: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/council/blind-review-db.test.ts`
Expected: PASS — 4 tests now

- [ ] **Step 5: Commit**

```bash
git add src/types.ts tests/council/blind-review-db.test.ts
git commit -m "feat(types): AgentTier + BlindReview row/input/stats types"
```

---

## Task 3: Implement recordSession + recordScore writes

**Files:**
- Modify: `src/council/blind-review-db.ts`
- Modify: `tests/council/blind-review-db.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/council/blind-review-db.test.ts — extend
describe('BlindReviewDB writes', () => {
  it('recordSession inserts a session row', () => {
    const db = new BlindReviewDB(':memory:');
    db.recordSession({
      sessionId: 't1:1000',
      threadId: 1,
      topic: 'monorepo',
      agentIds: ['huahua', 'binbin'],
      startedAt: '2026-04-17T00:00:00Z',
      revealedAt: '2026-04-17T00:05:00Z',
    });
    expect(db.getSession('t1:1000')).toMatchObject({
      sessionId: 't1:1000',
      threadId: 1,
      topic: 'monorepo',
      agentIds: ['huahua', 'binbin'],
    });
  });

  it('recordScore inserts an event row', () => {
    const db = new BlindReviewDB(':memory:');
    db.recordSession({
      sessionId: 's1', threadId: 1, topic: null,
      agentIds: ['a1'], startedAt: 'now', revealedAt: null,
    });
    db.recordScore({
      sessionId: 's1', agentId: 'a1', tier: 'high',
      model: 'claude-opus-4-7', score: 4,
    });
    const events = db.getEventsForSession('s1');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ agentId: 'a1', tier: 'high', score: 4 });
  });

  it('recordScore stores feedbackText when provided', () => {
    const db = new BlindReviewDB(':memory:');
    db.recordSession({ sessionId: 's1', threadId: 1, topic: null, agentIds: ['a'], startedAt: 'now', revealedAt: null });
    db.recordScore({ sessionId: 's1', agentId: 'a', tier: 'low', model: 'haiku', score: 3, feedbackText: 'good' });
    expect(db.getEventsForSession('s1')[0].feedbackText).toBe('good');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/council/blind-review-db.test.ts`
Expected: FAIL — `db.recordSession is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `src/council/blind-review-db.ts`:

```typescript
import type {
  AgentTier,
  BlindReviewSessionRow,
  BlindReviewEventInput,
} from '../types.js';

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

// Inside BlindReviewDB class:
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
  ).get(sessionId) as {
    session_id: string; thread_id: number; topic: string | null;
    agent_ids: string; started_at: string; revealed_at: string | null;
  } | undefined;
  if (!row) return null;
  return {
    sessionId: row.session_id,
    threadId: row.thread_id,
    topic: row.topic,
    agentIds: JSON.parse(row.agent_ids) as string[],
    startedAt: row.started_at,
    revealedAt: row.revealed_at,
  };
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
  return rows.map((r) => ({
    eventId: r.event_id,
    sessionId: r.session_id,
    agentId: r.agent_id,
    tier: r.tier as AgentTier,
    model: r.model,
    score: r.score,
    feedbackText: r.feedback_text,
    scoredAt: r.scored_at,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/council/blind-review-db.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/council/blind-review-db.ts tests/council/blind-review-db.test.ts
git commit -m "feat(blind-review-db): recordSession + recordScore + getters"
```

---

## Task 4: Implement refreshStats and getStats

**Files:**
- Modify: `src/council/blind-review-db.ts`
- Modify: `tests/council/blind-review-db.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/council/blind-review-db.test.ts — extend
describe('BlindReviewDB stats', () => {
  function seed(db: BlindReviewDB, agentId: string, tier: AgentTier, scores: number[]) {
    const sid = `s-${Date.now()}-${Math.random()}`;
    db.recordSession({ sessionId: sid, threadId: 1, topic: null, agentIds: [agentId], startedAt: 'now', revealedAt: null });
    for (const s of scores) {
      db.recordScore({ sessionId: sid, agentId, tier, model: 'm', score: s });
    }
    db.refreshStats(agentId, tier);
  }

  it('getStats returns zero stats when no events', () => {
    const db = new BlindReviewDB(':memory:');
    expect(db.getStats('nobody', 'high')).toMatchObject({
      agentId: 'nobody',
      tier: 'high',
      sampleCount: 0,
      avgScore: 0,
      last5Scores: [],
    });
  });

  it('refreshStats aggregates events for (agent, tier)', () => {
    const db = new BlindReviewDB(':memory:');
    seed(db, 'a1', 'high', [5, 4, 3]);
    const stats = db.getStats('a1', 'high');
    expect(stats.sampleCount).toBe(3);
    expect(stats.avgScore).toBeCloseTo(4.0, 5);
    expect(stats.last5Scores).toEqual([5, 4, 3]);
  });

  it('last5Scores keeps only the most recent 5 in insertion order', () => {
    const db = new BlindReviewDB(':memory:');
    seed(db, 'a1', 'low', [1, 2, 3, 4, 5, 6, 7]);
    const stats = db.getStats('a1', 'low');
    expect(stats.last5Scores).toEqual([3, 4, 5, 6, 7]);
    expect(stats.sampleCount).toBe(7);
  });

  it('refreshStats skips events where tier is unknown', () => {
    const db = new BlindReviewDB(':memory:');
    db.recordSession({ sessionId: 's1', threadId: 1, topic: null, agentIds: ['a'], startedAt: 'now', revealedAt: null });
    db.recordScore({ sessionId: 's1', agentId: 'a', tier: 'unknown', model: 'm', score: 5 });
    db.recordScore({ sessionId: 's1', agentId: 'a', tier: 'high', model: 'm', score: 3 });
    db.refreshStats('a', 'high');
    db.refreshStats('a', 'unknown');
    expect(db.getStats('a', 'unknown').sampleCount).toBe(0);
    expect(db.getStats('a', 'high').sampleCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/council/blind-review-db.test.ts`
Expected: FAIL — `db.refreshStats is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `src/council/blind-review-db.ts`:

```typescript
import type {
  AgentTier,
  AgentTierStats,
  BlindReviewSessionRow,
  BlindReviewEventInput,
} from '../types.js';

// Inside BlindReviewDB class:

refreshStats(agentId: string, tier: AgentTier): void {
  if (tier === 'unknown') {
    this.db.prepare(
      `DELETE FROM blind_review_stats WHERE agent_id = ? AND tier = ?`
    ).run(agentId, tier);
    return;
  }
  const rows = this.db.prepare(
    `SELECT score FROM blind_review_events
       WHERE agent_id = ? AND tier = ?
       ORDER BY event_id ASC`
  ).all(agentId, tier) as { score: number }[];
  if (rows.length === 0) {
    this.db.prepare(
      `DELETE FROM blind_review_stats WHERE agent_id = ? AND tier = ?`
    ).run(agentId, tier);
    return;
  }
  const scores = rows.map((r) => r.score);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const last5 = scores.slice(-5);
  this.db.prepare(
    `INSERT OR REPLACE INTO blind_review_stats
       (agent_id, tier, sample_count, avg_score, last_5_scores, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    agentId,
    tier,
    scores.length,
    avg,
    JSON.stringify(last5),
    new Date().toISOString(),
  );
}

getStats(agentId: string, tier: AgentTier): AgentTierStats {
  const row = this.db.prepare(
    `SELECT * FROM blind_review_stats WHERE agent_id = ? AND tier = ?`
  ).get(agentId, tier) as {
    agent_id: string; tier: string; sample_count: number;
    avg_score: number; last_5_scores: string; updated_at: string;
  } | undefined;
  if (!row) {
    return {
      agentId,
      tier,
      sampleCount: 0,
      avgScore: 0,
      last5Scores: [],
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    agentId: row.agent_id,
    tier: row.tier as AgentTier,
    sampleCount: row.sample_count,
    avgScore: row.avg_score,
    last5Scores: JSON.parse(row.last_5_scores) as number[],
    updatedAt: row.updated_at,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/council/blind-review-db.test.ts`
Expected: PASS — 11 tests

- [ ] **Step 5: Commit**

```bash
git add src/council/blind-review-db.ts tests/council/blind-review-db.test.ts
git commit -m "feat(blind-review-db): refreshStats + getStats (skip tier=unknown)"
```

---

## Task 5: Transactional persistSession

**Files:**
- Modify: `src/council/blind-review-db.ts`
- Modify: `tests/council/blind-review-db.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/council/blind-review-db.test.ts — extend
describe('BlindReviewDB persistSession', () => {
  it('writes session + events + stats atomically', () => {
    const db = new BlindReviewDB(':memory:');
    db.persistSession({
      sessionRow: {
        sessionId: 's1', threadId: 1, topic: 'monorepo',
        agentIds: ['a1', 'a2'], startedAt: 'now', revealedAt: 'now',
      },
      scores: [
        { sessionId: 's1', agentId: 'a1', tier: 'high', model: 'opus', score: 4 },
        { sessionId: 's1', agentId: 'a2', tier: 'low', model: 'haiku', score: 2 },
      ],
    });
    expect(db.getEventsForSession('s1')).toHaveLength(2);
    expect(db.getStats('a1', 'high').sampleCount).toBe(1);
    expect(db.getStats('a2', 'low').sampleCount).toBe(1);
  });

  it('rolls back all writes if one recordScore violates FK', () => {
    const db = new BlindReviewDB(':memory:');
    expect(() => db.persistSession({
      sessionRow: { sessionId: 's2', threadId: 1, topic: null, agentIds: [], startedAt: 'now', revealedAt: 'now' },
      scores: [
        { sessionId: 's2', agentId: 'a1', tier: 'high', model: 'm', score: 4 },
        { sessionId: 'NONEXISTENT', agentId: 'a1', tier: 'high', model: 'm', score: 4 },
      ],
    })).toThrow();
    expect(db.getSession('s2')).toBeNull();
    expect(db.getEventsForSession('s2')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/council/blind-review-db.test.ts`
Expected: FAIL — `db.persistSession is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `BlindReviewDB`:

```typescript
persistSession(input: {
  sessionRow: BlindReviewSessionRow;
  scores: BlindReviewEventInput[];
}): void {
  const tx = this.db.transaction((arg: typeof input) => {
    this.recordSession(arg.sessionRow);
    for (const score of arg.scores) {
      this.recordScore(score);
    }
    const touched = new Set<string>();
    for (const s of arg.scores) {
      touched.add(`${s.agentId}::${s.tier}`);
    }
    for (const key of touched) {
      const [agentId, tier] = key.split('::');
      this.refreshStats(agentId, tier as AgentTier);
    }
  });
  tx(input);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/council/blind-review-db.test.ts`
Expected: PASS — 13 tests

- [ ] **Step 5: Commit**

```bash
git add src/council/blind-review-db.ts tests/council/blind-review-db.test.ts
git commit -m "feat(blind-review-db): transactional persistSession with rollback"
```

---

## Task 6: Pure functions — buildRecommendation + renderSparkline

**Files:**
- Modify: `src/council/blind-review-db.ts`
- Modify: `tests/council/blind-review-db.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/council/blind-review-db.test.ts — extend
import { buildRecommendation, renderSparkline } from '../../src/council/blind-review-db.js';

describe('buildRecommendation', () => {
  const base = { agentId: 'huahua', updatedAt: '2026-04-17' };

  it('n<5: 資料累積中', () => {
    expect(buildRecommendation({
      ...base, tier: 'high', sampleCount: 3, avgScore: 4, last5Scores: [4, 4, 4],
    }, { lowerTierModel: null, currentModel: 'opus' }))
      .toBe('資料累積中 (n=3/5)');
  });

  it('n=1: 首次評分', () => {
    expect(buildRecommendation({
      ...base, tier: 'high', sampleCount: 1, avgScore: 5, last5Scores: [5],
    }, { lowerTierModel: null, currentModel: 'opus' }))
      .toBe('首次評分 (n=1/5)');
  });

  it('n>=5 avg>=4: 維持現配置', () => {
    expect(buildRecommendation({
      ...base, tier: 'medium', sampleCount: 5, avgScore: 4.2, last5Scores: [4, 4, 5, 4, 4],
    }, { lowerTierModel: 'haiku', currentModel: 'sonnet' }))
      .toBe('維持現配置');
  });

  it('n>=5 avg 3-4: 表現尚可', () => {
    expect(buildRecommendation({
      ...base, tier: 'low', sampleCount: 5, avgScore: 3.2, last5Scores: [3, 3, 3, 4, 3],
    }, { lowerTierModel: null, currentModel: 'haiku' }))
      .toBe('表現尚可，持續觀察');
  });

  it('n>=5 avg 2-3 tier=high: suggest降到 lower tier', () => {
    expect(buildRecommendation({
      ...base, tier: 'high', sampleCount: 6, avgScore: 2.5, last5Scores: [2, 3, 2, 3, 3],
    }, { lowerTierModel: 'sonnet', currentModel: 'opus' }))
      .toBe('考慮將 huahua 在 high complexity 的 tier 從 opus 降到 sonnet');
  });

  it('n>=5 avg 2-3 tier=medium: suggest降到 low tier', () => {
    expect(buildRecommendation({
      ...base, tier: 'medium', sampleCount: 6, avgScore: 2.2, last5Scores: [2, 2, 3, 2, 2],
    }, { lowerTierModel: 'haiku', currentModel: 'sonnet' }))
      .toBe('考慮將 huahua 在 medium complexity 降到 low tier，或檢視 personality');
  });

  it('n>=5 avg 2-3 tier=low: personality review', () => {
    expect(buildRecommendation({
      ...base, tier: 'low', sampleCount: 6, avgScore: 2.5, last5Scores: [2, 3, 2, 3, 3],
    }, { lowerTierModel: null, currentModel: 'haiku' }))
      .toBe('評分偏低，建議檢視 huahua personality 或 topic 分配');
  });

  it('n>=5 avg<2: 汰換', () => {
    expect(buildRecommendation({
      ...base, tier: 'high', sampleCount: 7, avgScore: 1.5, last5Scores: [1, 2, 1, 2, 2],
    }, { lowerTierModel: 'sonnet', currentModel: 'opus' }))
      .toBe('評分持續過低，建議檢視 personality / topic 或考慮汰換 agent');
  });

  it('n<10 avg extreme: append 初期樣本', () => {
    expect(buildRecommendation({
      ...base, tier: 'medium', sampleCount: 7, avgScore: 4.9, last5Scores: [5, 5, 5, 5, 5],
    }, { lowerTierModel: 'haiku', currentModel: 'sonnet' }))
      .toBe('維持現配置（初期樣本，建議再觀察幾場）');
  });
});

describe('renderSparkline', () => {
  it('returns empty string for empty array', () => {
    expect(renderSparkline([])).toBe('');
  });

  it('renders 5 filled stars for [5,5,5,5,5]', () => {
    expect(renderSparkline([5, 5, 5, 5, 5])).toBe('★★★★★');
  });

  it('renders graded fill matching score values', () => {
    const out = renderSparkline([1, 2, 3, 4, 5]);
    expect(out).toHaveLength(5);
    expect(out[0]).toBe('☆');
    expect(out[4]).toBe('★');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/council/blind-review-db.test.ts`
Expected: FAIL — `buildRecommendation is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `src/council/blind-review-db.ts` (module scope, not inside class):

```typescript
export interface RecommendationContext {
  currentModel: string;
  lowerTierModel: string | null;
}

export function buildRecommendation(
  stats: AgentTierStats,
  ctx: RecommendationContext,
): string {
  const { sampleCount, avgScore, agentId, tier } = stats;

  if (sampleCount === 0) return '尚無資料';
  if (sampleCount === 1) return '首次評分 (n=1/5)';
  if (sampleCount < 5) return `資料累積中 (n=${sampleCount}/5)`;

  let body: string;
  if (avgScore >= 4.0) body = '維持現配置';
  else if (avgScore >= 3.0) body = '表現尚可，持續觀察';
  else if (avgScore >= 2.0) {
    if (tier === 'high') {
      const target = ctx.lowerTierModel ?? 'low tier';
      body = `考慮將 ${agentId} 在 high complexity 的 tier 從 ${ctx.currentModel} 降到 ${target}`;
    } else if (tier === 'medium') {
      body = `考慮將 ${agentId} 在 medium complexity 降到 low tier，或檢視 personality`;
    } else {
      body = `評分偏低，建議檢視 ${agentId} personality 或 topic 分配`;
    }
  } else {
    body = '評分持續過低，建議檢視 personality / topic 或考慮汰換 agent';
  }

  const extremeAvg = avgScore >= 4.8 || avgScore <= 1.5;
  if (sampleCount < 10 && extremeAvg) {
    body = `${body}（初期樣本，建議再觀察幾場）`;
  }
  return body;
}

export function renderSparkline(scores: number[]): string {
  if (scores.length === 0) return '';
  return scores.map((s) => (s >= 3.5 ? '★' : '☆')).join('');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/council/blind-review-db.test.ts`
Expected: PASS — 25 tests

- [ ] **Step 5: Commit**

```bash
git add src/council/blind-review-db.ts tests/council/blind-review-db.test.ts
git commit -m "feat(blind-review-db): buildRecommendation + renderSparkline"
```

---

## Task 7: Extend ProviderResponse with tierUsed + modelUsed

**Files:**
- Modify: `src/types.ts`
- Modify: `src/worker/agent-worker.ts`
- Create or extend: `tests/worker/agent-worker.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/worker/agent-worker.test.ts
import { describe, it, expect } from 'vitest';
import { AgentWorker } from '../../src/worker/agent-worker.js';
import type { AgentConfig, LLMProvider, ProviderResponse } from '../../src/types.js';

function fakeProvider(response: Partial<ProviderResponse> = {}): LLMProvider {
  return {
    name: 'fake',
    chat: async () => ({
      content: 'hi', tokensUsed: { input: 1, output: 1 }, ...response,
    } as ProviderResponse),
    summarize: async () => 'summary',
    estimateTokens: () => 0,
  };
}

describe('AgentWorker.respond tier/model reporting', () => {
  const cfg: AgentConfig = {
    id: 'test', name: 'Test', provider: 'fake', model: 'sonnet',
    memoryDir: '', personality: '',
    models: { low: 'haiku', medium: 'sonnet', high: 'opus' },
  };

  it('returns tierUsed=high and modelUsed=opus when complexity=high', async () => {
    const w = new AgentWorker(cfg, fakeProvider(), '');
    const r = await w.respond([], 'advocate', undefined, 'high');
    expect(r.tierUsed).toBe('high');
    expect(r.modelUsed).toBe('opus');
  });

  it('returns tierUsed=unknown when complexity is undefined', async () => {
    const w = new AgentWorker(cfg, fakeProvider(), '');
    const r = await w.respond([], 'advocate');
    expect(r.tierUsed).toBe('unknown');
    expect(r.modelUsed).toBe('sonnet');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/worker/agent-worker.test.ts`
Expected: FAIL — `tierUsed` is undefined.

- [ ] **Step 3: Write minimal implementation**

Update `src/types.ts` — extend `ProviderResponse`:

```typescript
export interface ProviderResponse {
  content: string;
  thinking?: string;
  skip?: boolean;
  skipReason?: string;
  confidence?: number;
  references?: string[];
  tokensUsed: { input: number; output: number };
  tierUsed?: AgentTier;
  modelUsed?: string;
}
```

Update `src/worker/agent-worker.ts` — at the bottom of `respond()`, return the extended object instead of the raw provider response:

```typescript
// ...existing logic unchanged up through the provider.chat() call and stats tracking...

return {
  ...response,
  tierUsed: complexity ?? 'unknown',
  modelUsed: model,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/worker/agent-worker.test.ts`
Expected: PASS — 2 tests. Also run full suite: `npx vitest run` — all previous tests green.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/worker/agent-worker.ts tests/worker/agent-worker.test.ts
git commit -m "feat(worker): return tierUsed + modelUsed in ProviderResponse"
```

---

## Task 8: BlindReviewSession gains turnLog + feedbackText

**Files:**
- Modify: `src/council/blind-review.ts`
- Modify: `tests/council/blind-review.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/council/blind-review.test.ts — extend
describe('BlindReviewStore tier tracking', () => {
  it('recordTurn stores (agentId, tier, model) per turn', () => {
    const store = new BlindReviewStore();
    const session = store.create(1, ['a', 'b'], new Map([['a', 'advocate'], ['b', 'critic']]));
    if ('error' in session) throw new Error(session.error);
    store.recordTurn(1, 'a', 'high', 'opus');
    store.recordTurn(1, 'b', 'low', 'haiku');
    const s = store.get(1)!;
    expect(s.turnLog).toEqual([
      { agentId: 'a', tier: 'high', model: 'opus' },
      { agentId: 'b', tier: 'low', model: 'haiku' },
    ]);
  });

  it('getLatestTurnFor returns the most recent (tier, model) for an agent', () => {
    const store = new BlindReviewStore();
    store.create(2, ['a'], new Map([['a', 'advocate']]));
    store.recordTurn(2, 'a', 'medium', 'sonnet');
    store.recordTurn(2, 'a', 'high', 'opus');
    expect(store.getLatestTurnFor(2, 'a')).toEqual({ tier: 'high', model: 'opus' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/council/blind-review.test.ts`
Expected: FAIL — `store.recordTurn is not a function`.

- [ ] **Step 3: Write minimal implementation**

Update `src/council/blind-review.ts`:

```typescript
import type { AgentTier } from '../types.js';

export interface TurnRecord {
  agentId: string;
  tier: AgentTier;
  model: string;
}

export interface BlindReviewSession {
  threadId: number;
  startedAt: number;
  codeToAgentId: Map<string, string>;
  agentIdToRole: Map<string, string>;
  scores: Map<string, number>;
  feedbackText: Map<string, string>;
  turnLog: TurnRecord[];
  revealed: boolean;
}
```

In `create()` initialize the new fields:

```typescript
const session: BlindReviewSession = {
  threadId,
  startedAt: Date.now(),
  codeToAgentId,
  agentIdToRole: new Map(roles),
  scores: new Map(),
  feedbackText: new Map(),
  turnLog: [],
  revealed: false,
};
```

Add methods to the class:

```typescript
recordTurn(threadId: number, agentId: string, tier: AgentTier, model: string): void {
  const session = this.sessions.get(threadId);
  if (!session || session.revealed) return;
  session.turnLog.push({ agentId, tier, model });
}

getLatestTurnFor(threadId: number, agentId: string): { tier: AgentTier; model: string } | null {
  const session = this.sessions.get(threadId);
  if (!session) return null;
  const record = [...session.turnLog].reverse().find((t) => t.agentId === agentId);
  return record ? { tier: record.tier, model: record.model } : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/council/blind-review.test.ts`
Expected: PASS — the two new tests + all existing blind-review tests green.

- [ ] **Step 5: Commit**

```bash
git add src/council/blind-review.ts tests/council/blind-review.test.ts
git commit -m "feat(blind-review): track per-turn (tier, model) in session"
```

---

## Task 9: Wire deliberation to call recordTurn

**Files:**
- Modify: `src/council/deliberation.ts`
- Extend: `tests/council/deliberation.test.ts` (or create `tests/council/deliberation-blind-review.test.ts`)

- [ ] **Step 1: Write the failing test**

Read `tests/council/deliberation.test.ts` first to match its test style. The new assertion:

```typescript
// after a blindReview=true deliberation:
expect(blindReviewStore.getLatestTurnFor(threadId, agentId))
  .toEqual({ tier: 'high', model: 'opus' });
```

If the existing test harness is too coupled to mock this path cleanly, create a narrower new file `tests/council/deliberation-blind-review.test.ts` that unit-tests just the wiring branch.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/council/deliberation.test.ts`
Expected: FAIL — turnLog empty.

- [ ] **Step 3: Write minimal implementation**

In `src/council/deliberation.ts`, after the existing `const response = await worker.respond(...)` (around lines 204-209), add:

```typescript
if (session.blindReview && this.blindReviewStore) {
  this.blindReviewStore.recordTurn(
    threadId,
    worker.id,
    response.tierUsed ?? 'unknown',
    response.modelUsed ?? 'unknown',
  );
}
```

Prerequisite plumbing:
1. Add `blindReviewStore?: BlindReviewStore` to `DeliberationHandler` options (the constructor already uses an options bag at position 5 per v0.3.1).
2. In `src/index.ts`, pass the shared `blindReviewStore` into the options.
3. `session.blindReview` is already set when `/blindreview` command fires (see `src/types.ts` `CouncilMessage.blindReview`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/council/deliberation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/council/deliberation.ts src/index.ts tests/council/deliberation.test.ts
git commit -m "feat(deliberation): record per-turn tier/model into blind-review session"
```

---

## Task 10: Add blind-review.persist-failed event

**Files:**
- Modify: `src/events/bus.ts`
- Extend: `tests/events/bus.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/events/bus.test.ts — extend
import type { EventMap } from '../../src/events/bus.js';

describe('EventMap blind-review.persist-failed', () => {
  it('has persist-failed event shape', () => {
    const evt: EventMap['blind-review.persist-failed'] = {
      threadId: 1,
      sessionId: 's1',
      error: new Error('disk full'),
    };
    expect(evt.error).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/events/bus.test.ts`
Expected: FAIL — TypeScript error.

- [ ] **Step 3: Write minimal implementation**

In `src/events/bus.ts`, add to `EventMap` interface near line 30-32:

```typescript
'blind-review.persist-failed': { threadId: number; sessionId: string; error: Error };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/events/bus.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events/bus.ts tests/events/bus.test.ts
git commit -m "feat(events): blind-review.persist-failed event"
```

---

## Task 11: markRevealed flushes to DB (fail-soft)

**Files:**
- Modify: `src/council/blind-review.ts`
- Modify: `tests/council/blind-review.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/council/blind-review.test.ts — extend
import { BlindReviewDB } from '../../src/council/blind-review-db.js';

describe('BlindReviewStore.markRevealed persistence', () => {
  it('persists session + scores to BlindReviewDB on reveal', () => {
    const db = new BlindReviewDB(':memory:');
    const store = new BlindReviewStore();
    store.attachDB(db);
    const session = store.create(1, ['a', 'b'], new Map([['a', 'advocate'], ['b', 'critic']]));
    if ('error' in session) throw new Error(session.error);
    store.recordTurn(1, 'a', 'high', 'opus');
    store.recordTurn(1, 'b', 'low', 'haiku');
    const codes = [...session.codeToAgentId.keys()];
    store.recordScore(1, codes[0], 5);
    store.recordScore(1, codes[1], 2);
    store.markRevealed(1);

    const sid = db.getRecentSessionId()!;
    expect(db.getEventsForSession(sid)).toHaveLength(2);
  });

  it('does not throw if DB flush fails; emits persist-failed event', () => {
    const failingDB = {
      persistSession: () => { throw new Error('disk full'); },
    } as unknown as BlindReviewDB;
    const emitted: Array<{ threadId: number; sessionId: string; error: Error }> = [];
    const store = new BlindReviewStore();
    store.attachDB(failingDB);
    store.onPersistFailed((evt) => emitted.push(evt));
    const session = store.create(9, ['a'], new Map([['a', 'advocate']]));
    if ('error' in session) throw new Error(session.error);
    store.recordTurn(9, 'a', 'high', 'opus');
    const code = [...session.codeToAgentId.keys()][0];
    store.recordScore(9, code, 3);
    expect(() => store.markRevealed(9)).not.toThrow();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].threadId).toBe(9);
  });
});
```

Also add a tiny helper to BlindReviewDB:

```typescript
getRecentSessionId(): string | null {
  const row = this.db.prepare(
    `SELECT session_id FROM blind_review_sessions ORDER BY started_at DESC LIMIT 1`
  ).get() as { session_id: string } | undefined;
  return row?.session_id ?? null;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/council/blind-review.test.ts`
Expected: FAIL — `store.attachDB is not a function`.

- [ ] **Step 3: Write minimal implementation**

Update `src/council/blind-review.ts`:

```typescript
import type { BlindReviewDB } from './blind-review-db.js';

type PersistFailedHandler = (evt: { threadId: number; sessionId: string; error: Error }) => void;

// Inside class BlindReviewStore:
private db: BlindReviewDB | null = null;
private persistFailedHandlers: PersistFailedHandler[] = [];

attachDB(db: BlindReviewDB): void {
  this.db = db;
}

onPersistFailed(handler: PersistFailedHandler): void {
  this.persistFailedHandlers.push(handler);
}

markRevealed(threadId: number): void {
  const session = this.sessions.get(threadId);
  if (!session) return;
  session.revealed = true;
  if (!this.db) return;

  const sessionId = `${threadId}:${session.startedAt}`;
  const now = new Date().toISOString();
  const startedAtIso = new Date(session.startedAt).toISOString();

  const scores: Array<{
    sessionId: string; agentId: string; tier: AgentTier; model: string; score: number;
  }> = [];
  for (const [code, score] of session.scores.entries()) {
    const agentId = session.codeToAgentId.get(code);
    if (!agentId) continue;
    const latest = this.getLatestTurnFor(threadId, agentId);
    scores.push({
      sessionId,
      agentId,
      tier: latest?.tier ?? 'unknown',
      model: latest?.model ?? 'unknown',
      score,
    });
  }

  try {
    this.db.persistSession({
      sessionRow: {
        sessionId,
        threadId,
        topic: null,
        agentIds: [...session.codeToAgentId.values()],
        startedAt: startedAtIso,
        revealedAt: now,
      },
      scores,
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    for (const h of this.persistFailedHandlers) {
      h({ threadId, sessionId, error: err });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/council/blind-review.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/council/blind-review.ts src/council/blind-review-db.ts tests/council/blind-review.test.ts
git commit -m "feat(blind-review): persist to DB on markRevealed (fail-soft)"
```

---

## Task 12: formatRevealMessage shows stats + recommendation

**Files:**
- Modify: `src/council/blind-review.ts`
- Modify: `tests/council/blind-review.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/council/blind-review.test.ts — extend
describe('formatRevealMessage with stats', () => {
  function makeSession(agentMeta: Array<{ id: string; name: string; role: string }>): BlindReviewSession {
    const ids = agentMeta.map((m) => m.id);
    const codeMap = new Map<string, string>();
    ids.forEach((id, i) => codeMap.set(`Agent-${String.fromCharCode(65 + i)}`, id));
    return {
      threadId: 1, startedAt: Date.now(),
      codeToAgentId: codeMap,
      agentIdToRole: new Map(agentMeta.map((m) => [m.id, m.role])),
      scores: new Map([['Agent-A', 4]]),
      feedbackText: new Map(),
      turnLog: [{ agentId: ids[0], tier: 'high', model: 'opus' }],
      revealed: true,
    };
  }

  it('shows 資料累積中 when sample_count < 5', () => {
    const db = new BlindReviewDB(':memory:');
    const session = makeSession([{ id: 'huahua', name: '花花', role: 'advocate' }]);
    const msg = formatRevealMessage(session, new Map([['huahua', { name: '花花', role: 'advocate' }]]), {
      db,
      modelConfigForAgent: () => ({ high: 'opus', medium: 'sonnet', low: 'haiku' }),
    });
    expect(msg).toContain('資料累積中');
  });

  it('shows recommendation when sample_count >= 5', () => {
    const db = new BlindReviewDB(':memory:');
    db.recordSession({ sessionId: 'seed', threadId: 0, topic: null, agentIds: ['huahua'], startedAt: 'now', revealedAt: 'now' });
    for (let i = 0; i < 5; i++) {
      db.recordScore({ sessionId: 'seed', agentId: 'huahua', tier: 'high', model: 'opus', score: 2 });
    }
    db.refreshStats('huahua', 'high');

    const session = makeSession([{ id: 'huahua', name: '花花', role: 'advocate' }]);
    const msg = formatRevealMessage(session, new Map([['huahua', { name: '花花', role: 'advocate' }]]), {
      db,
      modelConfigForAgent: () => ({ high: 'opus', medium: 'sonnet', low: 'haiku' }),
    });
    expect(msg).toContain('降到');
    expect(msg).toContain('sonnet');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/council/blind-review.test.ts`
Expected: FAIL — new `formatRevealMessage` signature mismatch.

- [ ] **Step 3: Write minimal implementation**

Replace `formatRevealMessage` in `src/council/blind-review.ts`:

```typescript
import { buildRecommendation, renderSparkline } from './blind-review-db.js';
import type { BlindReviewDB } from './blind-review-db.js';

export interface FormatRevealOptions {
  db?: BlindReviewDB;
  modelConfigForAgent?: (agentId: string) => { low: string; medium: string; high: string } | null;
}

export function formatRevealMessage(
  session: BlindReviewSession,
  agentMeta: Map<string, { name: string; role: string }>,
  opts: FormatRevealOptions = {},
): string {
  const lines: string[] = ['🎭 Blind Review Reveal', ''];
  for (const [code, agentId] of session.codeToAgentId.entries()) {
    const name = agentMeta.get(agentId)?.name ?? agentId;
    const role = session.agentIdToRole.get(agentId) ?? agentMeta.get(agentId)?.role ?? 'unknown';
    const score = session.scores.get(code);
    const scoreStr = score !== undefined ? `your score: ${score}★` : 'not scored';

    const latest = session.turnLog.slice().reverse().find((t) => t.agentId === agentId);
    const tier = latest?.tier ?? 'unknown';
    const model = latest?.model ?? 'unknown';

    lines.push(`${code} → ${name} (${model}, ${role}) — ${scoreStr}`);

    if (opts.db && tier !== 'unknown') {
      const stats = opts.db.getStats(agentId, tier);
      const sparkline = stats.sampleCount > 0 ? renderSparkline(stats.last5Scores) : '';
      if (stats.sampleCount >= 1) {
        lines.push(`  歷史 (n=${stats.sampleCount}, avg ${stats.avgScore.toFixed(1)}): ${sparkline}`);
      }

      const tierMap = opts.modelConfigForAgent?.(agentId) ?? null;
      const lowerTierModel = resolveLowerTier(tier, tierMap);
      const ctx = { currentModel: model, lowerTierModel };
      lines.push(`  建議: ${buildRecommendation(stats, ctx)}`);
    }
  }
  lines.push('');
  lines.push('(Identities revealed; scores recorded for this round.)');
  return lines.join('\n');
}

function resolveLowerTier(
  tier: AgentTier,
  tierMap: { low: string; medium: string; high: string } | null,
): string | null {
  if (!tierMap) return null;
  if (tier === 'high') return tierMap.medium;
  if (tier === 'medium') return tierMap.low;
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/council/blind-review.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/council/blind-review.ts tests/council/blind-review.test.ts
git commit -m "feat(blind-review): reveal message shows stats + recommendation"
```

---

## Task 13: Wire BlindReviewDB into src/index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Check existing wiring**

Read `src/index.ts` to see how `BlindReviewStore` and `MemoryDB` are instantiated. Follow the same pattern.

- [ ] **Step 2: Write minimal implementation**

Near where `BlindReviewStore` is created (or adjacent to `MemoryDB`):

```typescript
import { BlindReviewDB } from './council/blind-review-db.js';

const blindReviewDB = new BlindReviewDB('data/council.db');
blindReviewStore.attachDB(blindReviewDB);
blindReviewStore.onPersistFailed((evt) => {
  eventBus.emit('blind-review.persist-failed', evt);
  console.error('[blind-review] persist failed:', evt);
});
```

Also pass `blindReviewStore` into the `DeliberationHandler` options (confirms Task 9's plumbing is complete).

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: ALL tests pass.

- [ ] **Step 4: Smoke test manually (optional but recommended)**

Start bot: `npm run dev` (or CLI: `npm run cli`). Run `/blindreview <topic>` in a test thread, score the agents, verify reveal message now shows "首次評分 (n=1/5)" (first run).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(bootstrap): wire BlindReviewDB + persist-failed event"
```

---

## Task 14: rebuildStats safety net

**Files:**
- Modify: `src/council/blind-review-db.ts`
- Modify: `tests/council/blind-review-db.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/council/blind-review-db.test.ts — extend
describe('BlindReviewDB.rebuildStats', () => {
  it('reconstructs stats table from events', () => {
    const db = new BlindReviewDB(':memory:');
    db.recordSession({ sessionId: 's1', threadId: 1, topic: null, agentIds: ['a1'], startedAt: 'now', revealedAt: null });
    for (const score of [2, 3, 4]) {
      db.recordScore({ sessionId: 's1', agentId: 'a1', tier: 'medium', model: 'sonnet', score });
    }
    // Do NOT call refreshStats — mimic a drift scenario
    expect(db.getStats('a1', 'medium').sampleCount).toBe(0);

    db.rebuildStats();
    expect(db.getStats('a1', 'medium').sampleCount).toBe(3);
    expect(db.getStats('a1', 'medium').avgScore).toBeCloseTo(3, 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/council/blind-review-db.test.ts`
Expected: FAIL — `db.rebuildStats is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `BlindReviewDB`:

```typescript
rebuildStats(): void {
  const pairs = this.db.prepare(
    `SELECT DISTINCT agent_id, tier FROM blind_review_events WHERE tier != 'unknown'`
  ).all() as { agent_id: string; tier: string }[];
  const tx = this.db.transaction(() => {
    this.db.exec('DELETE FROM blind_review_stats');
    for (const p of pairs) {
      this.refreshStats(p.agent_id, p.tier as AgentTier);
    }
  });
  tx();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/council/blind-review-db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/council/blind-review-db.ts tests/council/blind-review-db.test.ts
git commit -m "feat(blind-review-db): rebuildStats for drift recovery"
```

---

## Task 15: CHANGELOG + PR

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add an [Unreleased] entry**

Prepend to `CHANGELOG.md` (above the current top entry):

```markdown
## [Unreleased]

### Added
- `BlindReviewDB` persists `/blindreview` scores to `data/council.db` (3-table audit trail: sessions, events, stats).
- Reveal message now includes per-(agent, tier) historical sparkline + rule-based routing recommendation when sample_count >= 5.
- `blind-review.persist-failed` event for DB write failures (fail-soft; reveal still sends).
- `AgentWorker.respond` returns `tierUsed` + `modelUsed` in `ProviderResponse`.
- `BlindReviewStore.recordTurn` / `getLatestTurnFor` / `attachDB` / `onPersistFailed`.
- `BlindReviewDB.rebuildStats` for drift recovery.

### Changed
- `formatRevealMessage` signature gained an optional `FormatRevealOptions` bag (`db`, `modelConfigForAgent`). Callers without the bag get the existing behavior.
- `BlindReviewSession` gained `turnLog` and `feedbackText` fields.
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: ALL tests pass (+20–25 new tests over baseline).

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG for blind-review → model routing closed-loop"
```

- [ ] **Step 4: Push and open PR**

```bash
git push -u origin feat/blind-review-routing-loop
gh pr create --title "feat: blind-review → model routing closed-loop" --body "$(cat <<'EOF'
## Summary
- Persists /blindreview scores to new data/council.db with 3-table audit trail.
- Reveal message now shows per-(agent, tier) sparkline + rule-based routing recommendation (n >= 5).
- User retains council.yaml authority; system only suggests.

## Design
See docs/superpowers/specs/2026-04-17-blind-review-routing-loop-design.md.

## Test plan
- [ ] Run /blindreview <topic> once — verify reveal shows "首次評分 (n=1/5)".
- [ ] Run /blindreview 5+ times against the same agent — verify reveal shows sparkline + recommendation.
- [ ] Verify data/council.db contains rows in blind_review_sessions, blind_review_events, blind_review_stats.
- [ ] Simulate DB failure (read-only) — verify reveal still fires; check console for persist-failed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Notes

**Spec coverage Q1–Q7:**
- Q1 per-agent-tier → Task 4 `refreshStats(agentId, tier)` indexed by `(agent_id, tier)`
- Q2 hybrid (suggest + user confirms) → Task 12 shows recommendation; no code path mutates council.yaml
- Q3 optional free-text → `feedbackText` field in Tasks 2, 8, 11
- Q4 3 tables full audit → Task 1 schema
- Q5 >=5 threshold → Task 6 `buildRecommendation`
- Q6 reveal integration → Task 12
- Q7 rule-based template → Task 6 is a pure function, no LLM call

**Error handling:**
- DB write fail-soft → Task 11 try/catch + `onPersistFailed`
- `tier='unknown'` filtered → Task 4 guard
- Transaction rollback → Task 5 FK + better-sqlite3 transaction
- Drift recovery → Task 14 `rebuildStats`

**Type consistency:**
- `AgentTier` (Task 2) used consistently throughout
- `BlindReviewEventInput` / `AgentTierStats` / `BlindReviewSessionRow` types defined once
- `ProviderResponse.tierUsed` + `modelUsed` optional (backward compatible)

**No placeholders:** All code blocks are complete. Task 9 flags one planning decision (mock wiring in existing test vs. write a narrower test) — that is a real choice for the implementer, not a handwave.
