# Blind-Review → Model Routing Closed Loop — Design

**Date:** 2026-04-17
**Author:** Cheng-I Wu
**Status:** Draft (pending implementation)
**Related:** v0.3.0 blind-review, v0.3.x model tier routing

## Goal

Turn `/blindreview` scoring data into an actionable signal for model routing. Persist scores across sessions, aggregate per-(agent, tier), and surface template-based recommendations to the user at reveal time. User retains full authority over `council.yaml` changes; the system only observes and suggests.

## Design Decisions

| ID | Question | Decision |
|----|----------|----------|
| Q1 | Score aggregation granularity | per-(agent, tier) |
| Q2 | Closed-loop mode | Hybrid: auto-suggest + user confirmation |
| Q3 | Score payload | 1-5 stars + optional free-text feedback |
| Q4 | Persistence schema | Full audit trail (3 dedicated tables) |
| Q5 | Cold-start threshold | ≥5 samples per (agent, tier) to give a recommendation |
| Q6 | Recommendation surface | Appended to `/blindreview` reveal message |
| Q7 | Recommendation text generation | Rule-based template (no LLM call) |

Rationale for rejected options documented in the brainstorming transcript (2026-04-17 session).

## Architecture

```
┌──────────────────────────────────────┐
│ src/council/blind-review.ts          │  existing, extended
│  - BlindReviewStore (in-memory)      │
│  - formatRevealMessage() — extended  │
└──────────────┬───────────────────────┘
               │ uses
               ↓
┌──────────────────────────────────────┐
│ src/council/blind-review-db.ts       │  NEW
│  - BlindReviewDB class               │
│  - schema migration (3 tables)       │
│  - recordSession / recordScore       │
│  - getStats(agentId, tier)           │
│  - buildRecommendation() — template  │
│  - rebuildStats() — cache rebuild    │
└──────────────┬───────────────────────┘
               │ writes
               ↓
┌──────────────────────────────────────┐
│ data/council.db  (NEW file)          │
│  blind_review_sessions               │
│  blind_review_events                 │
│  blind_review_stats (materialized)   │
└──────────────────────────────────────┘
```

`data/council.db` is separate from `data/brain.db` (the memory system). System-level metrics stay isolated from agent memory to avoid both language ambiguity and the self-sycophancy risk of letting agents read their own scores.

`BlindReviewDB` follows the existing `MemoryDB` pattern: class-owned database, `CREATE TABLE IF NOT EXISTS` migration in the constructor, no framework.

## Data Schema

```sql
-- 1) A blind-review session
CREATE TABLE IF NOT EXISTS blind_review_sessions (
  session_id TEXT PRIMARY KEY,         -- threadId:startedAt
  thread_id INTEGER NOT NULL,
  topic TEXT,                          -- deliberation topic (nullable)
  agent_ids TEXT NOT NULL,             -- JSON array of participating agent ids
  started_at TEXT NOT NULL,
  revealed_at TEXT                     -- null = session cancelled before reveal
);

-- 2) One row per score click (atomic record)
CREATE TABLE IF NOT EXISTS blind_review_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tier TEXT NOT NULL,                  -- 'low' | 'medium' | 'high' | 'unknown'
  model TEXT NOT NULL,                 -- actual model used, e.g. 'claude-opus-4-7'
  score INTEGER NOT NULL,              -- 1-5
  feedback_text TEXT,                  -- optional free-text
  scored_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES blind_review_sessions(session_id)
);

CREATE INDEX IF NOT EXISTS idx_events_agent_tier
  ON blind_review_events(agent_id, tier);

-- 3) Aggregated cache (rebuildable from events)
CREATE TABLE IF NOT EXISTS blind_review_stats (
  agent_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  sample_count INTEGER NOT NULL,
  avg_score REAL NOT NULL,
  last_5_scores TEXT NOT NULL,         -- JSON array for sparkline
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, tier)
);
```

### Schema Rationale

- **`model` column**: tier is an abstraction that points to different models over time (today `high`=opus-4-7, tomorrow sonnet-4-6). Storing the actual model per event allows post-hoc analysis like "opus scores 4.3★ in high-complexity, sonnet 3.1★."
- **Stats cache**: reveal path needs O(1) lookup. Events remain the source of truth; stats are rebuildable.
- **`topic` on session**: zero-cost to store now; supports a future per-(agent, tier, topic) upgrade without migration.
- **`session_id` format**: `threadId:startedAt` is human-readable and debuggable; no UUID dependency needed.
- **`tier='unknown'`**: accepted when worker cannot determine the tier used (timeout, fallback), filtered out of stats queries.

## Data Flow

### Write Path

```
/blindreview <topic>
  → BlindReviewStore.create(threadId, agentIds, roles)    [in-memory]
  → deliberation runs
      — AgentWorker tags each turn with (tier, model) used
      — these tags attach to the session object
  → user taps 1-5★ for each agent (grammY inline keyboard)
  → BlindReviewStore.recordScore(threadId, code, score, feedbackText?)
  → all agents scored → markRevealed(threadId)
      ↓
      [NEW] BlindReviewDB.persistSession(session) inside a single transaction:
        recordSession(...)
        for each score: recordScore(...)       — writes to blind_review_events
        for each touched (agent, tier): refreshStats(agentId, tier)
                                                — rebuilds that (agent, tier) row from events
                                                — skips rows where tier='unknown'
      ↓
      formatRevealMessage(session) — includes stats + recommendation
```

Transaction ensures all-or-nothing persistence.

### Read Path (at reveal)

```
formatRevealMessage(session):
  for each agent in session:
    stats = BlindReviewDB.getStats(agent.id, agent.tier)
    if stats.sample_count >= 5:
      sparkline = renderSparkline(stats.last_5_scores)
      recommendation = buildRecommendation(stats)
    else:
      sparkline = null
      recommendation = `資料累積中 (n=${stats.sample_count}/5)`
```

Example reveal message:

```
🎭 Blind Review Reveal
Agent-A = 花花 (haiku, advocate) → 你的評分: ⭐⭐⭐⭐
  歷史 (n=8, avg 3.6): ★★★☆☆ ← last 5
  建議: 維持現配置

Agent-B = 賓賓 (opus-4-7 high-xhigh, critic) → 你的評分: ⭐⭐
  歷史 (n=6, avg 2.3): ★★☆☆☆
  建議: 考慮將賓賓在 high complexity 的 tier 從 opus 降到 sonnet
```

### Recommendation Template (buildRecommendation)

Pure function. Rule table:

| avg_score | tier | Template |
|-----------|------|----------|
| ≥ 4.0 | any | 維持現配置 |
| 3.0–4.0 | any | 表現尚可，持續觀察 |
| 2.0–3.0 | `high` | 考慮將 `<agent>` 在 high complexity 的 tier 從 `<current_model>` 降到 `<lower_tier_model>`. `<lower_tier_model>` resolves from `council.yaml` agent config: `high → medium → low`; if already on `low`, fall through to the next rule. |
| 2.0–3.0 | `medium` | 考慮將 `<agent>` 在 medium complexity 降到 low tier，或檢視 personality |
| 2.0–3.0 | `low` | 評分偏低，建議檢視 `<agent>` personality 或 topic 分配 |
| < 2.0 | any | 評分持續過低，建議檢視 personality / topic 或考慮汰換 agent |

Edge cases:

- `sample_count < 5`: show `資料累積中 (n=N/5)`, no recommendation.
- `sample_count < 10` and avg extreme (≤1.5 or ≥4.8): append `（初期樣本，建議再觀察幾場）`.
- `sample_count = 1`: show `首次評分` instead of "累積中".

## Error Handling

| Failure | Strategy |
|---------|----------|
| DB write fails at `markRevealed` flush | Fail-soft: reveal message still sends, console.error, emit `blind-review.persist-failed` event, no retry. |
| Agent tier/model data incomplete | Store `tier='unknown'`, filter out in `getStats`, keep row for debugging. |
| User scores after `/cancelreview` or bot restart | Existing `BlindReviewStore` guards (`no session for thread`) already handle this — no new code. |
| Stats/events drift | Wrap recordScore + refreshStats in single transaction; expose `rebuildStats()`; `getStats` auto-triggers rebuild if `stats.updated_at` falls behind latest event by > threshold. |
| First-time user on new version | `BlindReviewDB` constructor auto-creates `data/council.db` + tables; no migration script needed. Pre-upgrade in-memory sessions are not backfilled (acceptable data loss). |

Rationale for fail-soft: the primary value of `/blindreview` is real-time deliberation + transparent scoring. Persistence is a bonus. A DB issue must never block user-facing flow.

## Testing

Follow existing vitest pattern: `tests/` mirrors `src/`.

### Unit — `tests/council/blind-review-db.test.ts`

Schema + CRUD:
- Constructor creates tables; re-running is idempotent (`IF NOT EXISTS`).
- `recordSession` + `recordScore` write correctly, FK binds.
- Transaction rollback when `refreshStats` throws.
- `getStats` edge cases: 0 / 1 / 5+ samples.
- `rebuildStats` reconstructs stats identical to incremental updates.

`buildRecommendation` (pure function):
- avg 4.5 → "維持現配置"
- avg 3.5 → "表現尚可"
- avg 2.5 + tier=high → contains "降到" and `<lower_tier_model>`
- avg 2.5 + tier=low → "檢視 personality"
- avg 1.5 → "考慮汰換"
- sample_count=3 → "資料累積中 (n=3/5)"
- sample_count=1 → "首次評分"
- sample_count=7, avg 4.9 → "初期樣本" suffix

Sparkline:
- `[5,5,5,5,5]` → `★★★★★`
- `[1,2,3,4,5]` → ascending visual
- `[]` → empty string

### Integration — `tests/council/blind-review-integration.test.ts`

Extend existing blind-review tests:
- After `markRevealed()`: events table has N rows (N = agent count).
- After `markRevealed()`: stats table `sample_count` incremented for each (agent, tier).
- DB flush failure → reveal message still sent (fail-soft).
- `formatRevealMessage` shows "累積中" when n<5, shows recommendation when n≥5.

### Events — `tests/events/bus.test.ts` (extend)

- `blind-review.persist-failed` emitted on DB write failure.
- `blind-review.revealed` payload includes stats snapshot.

### Not Covered

- `better-sqlite3` internals (external dependency).
- SQLite WAL/journal behavior.
- grammY inline keyboards (already covered in v0.3.0).
- Load testing (single-user, deferred to future work).

### Test Infrastructure

- Use `:memory:` SQLite (better-sqlite3 native support).
- Independent DB instance per test, no shared state.
- Estimated ~20+ new tests (unit 15+, integration 6+, events 2+).

## Implementation Checklist

1. Create `src/council/blind-review-db.ts` with schema migration + CRUD.
2. Extend `BlindReviewStore.markRevealed()` to flush to `BlindReviewDB` inside a transaction.
3. Ensure `AgentWorker` tags each turn with the tier/model used, propagated to the session.
4. Extend `formatRevealMessage` in `blind-review.ts` to include per-(agent, tier) stats and recommendation.
5. Add events `blind-review.persist-failed` to EventMap + fire on DB failure.
6. Write unit, integration, event tests per plan above.
7. Update `CHANGELOG.md` under an `[Unreleased]` section; the final version number is assigned at release time (not at plan time).

## Out of Scope

- Per-(agent, tier, topic) granularity (documented as a migration-safe future upgrade).
- Active-push notifications outside `/blindreview` reveal context.
- `/routing` dashboard command (deferred; current design reads stats only on reveal).
- LLM-generated recommendations (rejected in Q7 — rule-based templates are deterministic and cheaper).
- Automatic `council.yaml` modification (rejected in Q2 — user retains authority).
- ML-based quality prediction on accumulated scores (future work once stats table is mature).
