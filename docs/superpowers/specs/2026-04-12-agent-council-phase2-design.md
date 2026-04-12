# Agent Council Phase 2 — Memory & Intelligence Design Spec

**Date:** 2026-04-12
**Author:** 吳政宜 + 花花 (Claude Opus 4.6)
**Status:** Draft — pending user review
**Prerequisite:** Phase 1 MVP complete (20 commits, 47 tests)

---

## 1. Overview

**Goal:** Add cognitive-science-inspired memory lifecycle and anti-pattern detection to agent-council MVP.

**Key inputs:**
- Phase 1 spec: `docs/superpowers/specs/2026-04-12-agent-council-design.md`
- Research: everything-claude-code (instinct evolution), claude-mem (progressive disclosure), GBrain (compiled truth + timeline)
- Cognitive science: Fuzzy-Trace Theory, Bjork, Ebbinghaus, Tulving, Nelson & Narens

**Decisions made during brainstorm:**
- Storage: SQLite metadata + markdown content (hybrid)
- Anti-pattern intervention: silent injection (no public alerts)
- Session end trigger: keywords + timeout + turn count (all three)

---

## 2. Memory System Architecture

### 2.1 Storage: Dual-Track (GBrain-inspired)

```
data/
├── brain.db              ← SQLite: metadata, usage tracking, FTS5 index
├── huahua/
│   ├── sessions/         ← markdown: session summaries (episodic memory)
│   ├── principles/       ← markdown: consolidated principles (semantic memory)
│   └── archive/          ← markdown: forgotten memories
└── binbin/
    └── ...
```

### 2.2 brain.db Schema

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,              -- 'huahua/sessions/council-session-2026-04-12-monorepo.md'
  agent_id TEXT NOT NULL,           -- 'huahua'
  type TEXT NOT NULL,               -- 'session' | 'principle' | 'archive'
  topic TEXT,                       -- 'monorepo', 'architecture'
  confidence REAL DEFAULT 0.7,      -- 0-1
  outcome TEXT,                     -- 'decision' | 'open' | 'deferred'
  usage_count INTEGER DEFAULT 0,
  last_used TEXT,                   -- ISO date
  created_at TEXT NOT NULL,
  content_preview TEXT              -- first 200 chars for FTS5
);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  id, topic, content_preview, content='memories'
);

CREATE TABLE patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  behavior TEXT NOT NULL,           -- 'tends toward conservative positions'
  extracted_from TEXT NOT NULL,      -- principle ID that generated this
  created_at TEXT NOT NULL
);
```

### 2.3 Progressive Disclosure (claude-mem inspired)

Three-layer loading replaces the current flat `loadAllMemories()`:

| Layer | Method | Returns | Cost |
|-------|--------|---------|------|
| L1 | `searchMemories(query)` | `{id, topic, confidence, preview}[]` | ~50 tokens/item |
| L2 | `getMemoryMeta(id)` | Full metadata row (no content) | ~20 tokens |
| L3 | `getMemoryContent(id)` | Full markdown file content | Variable |

Agent worker startup: load L1 only. Expand to L3 on-demand based on topic relevance.

---

## 3. Memory Five-Layer Lifecycle

### Layer 1: Automatic Gist Extraction

**Trigger (any of):**
- Human message contains end keywords: 「結束」「done」「結論」「wrap up」「總結」
- Group silent for `session_timeout_ms` (default: 600,000ms = 10 min)
- Turn count reaches `session_max_turns` (default: 20)

**Behavior:**
1. LLM generates 200-300 word gist from conversation history
2. LLM determines `outcome` (decision/open/deferred) and `confidence`
3. Save markdown to `data/{agent}/sessions/council-session-{date}-{topic}.md`
4. Insert metadata row into `brain.db` `memories` table
5. Send summary message to group: 「📋 Council 摘要：[topic] — [outcome]」
6. Check if consolidation threshold is reached (Layer 4)
7. Reset router state for next session

### Layer 2: Adaptive Forgetting (Bjork & Bjork)

**Trigger:** Weekly scheduled check, or when `memories` count exceeds `archive_threshold` (default: 30)

**Retrieval score formula:**
```
retrieval_score = usage_count × recency_weight
recency_weight = 1 / (1 + days_since_last_used / 7)
```

**Behavior:**
- Calculate retrieval score for all active (non-archived) memories
- Bottom `archive_bottom_percent` (default: 20%) → move markdown to `archive/`, update `type = 'archive'` in brain.db
- If an archived memory is referenced again → pull back to active, update type

### Layer 3: Usage Frequency Tracking (Ebbinghaus)

**Behavior:**
- Agent worker system prompt instructs agents to mark references: `[ref:filename.md]` (e.g., `[ref:principle-architecture.md]`)
- After each response, router uses regex `/\[ref:([^\]]+)\]/g` to extract filenames
- Updates `usage_count` and `last_used` in brain.db
- Higher usage_count memories are loaded first in L1 search results

### Layer 4: Episodic→Semantic Consolidation (Tulving)

**Trigger:** Same `topic` has `consolidation_threshold` (default: 5) or more session summaries

**Behavior:**
1. LLM analyzes all session summaries for the topic
2. Extracts general principles → saves to `data/{agent}/principles/principle-{topic}.md`
3. Extracts behavioral pattern → inserts into `patterns` table
4. Original session summaries move to `archive/`, type updated in brain.db
5. Principle replaces them as the canonical memory for that topic

**Compiled Truth + Timeline (GBrain concept):**
- `principles/` = compiled truth (rewritable, always current)
- `sessions/` + `archive/` = timeline (append-only evidence)

### Layer 5: Confidence Tagging (Nelson & Narens)

**Assignment rules:**
| Scenario | Confidence |
|----------|------------|
| Both agents agree on conclusion | 0.8 - 1.0 |
| Disagreement, human arbitrated | 0.7 |
| Disagreement, deferred (no resolution) | 0.3 - 0.5 |

**Behavior:**
- Confidence set during gist extraction (Layer 1)
- When loading a memory with confidence < 0.5, auto-append warning: *「此結論有爭議 — 花花和賓賓持不同觀點」*

---

## 4. Anti-Pattern Detection

### 4.1 Four Patterns (Silent Injection)

| Pattern | Detection | Injection Prompt |
|---------|-----------|-----------------|
| **Mirror response** | LLM compares two agents' responses, semantic similarity > 0.8 | 「你的回覆跟對方高度重疊。提出一個對方沒提到的面向。」 |
| **Fake dissent** | Opens with disagreement but reaches same conclusion (LLM judgment) | 「你聲稱不同意但結論一致。什麼情況下你會得出不同結論？」 |
| **Quick surrender** | Agent had a position last turn, fully accepts opponent's view this turn after one challenge | 「你在一次反對後就改變立場。那個反對真的推翻了你的論點嗎？」 |
| **Authority submission** | Human agrees with Agent A, Agent B immediately changes stance to match | 「你在人類表態後改變了觀點。請基於論點本身評估，不是因為人類同意了對方。」 |

### 4.2 Implementation

New `PatternDetector` class in `src/council/pattern-detector.ts`:

- Input: last 3 turns of conversation
- Method: single LLM call (~200 tokens prompt) to a cheap model (configurable, default Haiku)
- Output: `{ detected: PatternType | null, target_agent: string }`
- Integration: Gateway calls `detectPattern()` after each agent response; if detected, injects prompt silently into next turn's challenge prompt

### 4.3 Cost Control

- Skip detection for first 3 turns (insufficient context)
- Run detection every 2 turns, not every turn
- Use `pattern_detection_model` (default: `claude-haiku-4-5-20251001`) — cheaper than main model

---

## 5. Instinct Evolution (Simplified, ECC-inspired)

Not building the full 47-agent instinct system. Lightweight version:

**Pattern extraction:** During Layer 4 consolidation, LLM also extracts a behavioral pattern:
- Format: "When discussing [topic], [agent] tends toward [behavior]"
- Stored in `patterns` table in brain.db

**Pattern application:** During role assignment, Gateway queries patterns table:
- If pattern shows Agent X tends toward behavior Y, consider assigning the opposite role
- Example: "花花 tends toward conservative positions on architecture" → assign 花花 as advocate to force positive-case thinking
- This is advisory, not deterministic — role assigner can use or ignore

---

## 6. Session Lifecycle (Complete Flow)

```
Human sends message
  → Gateway receives
  → Check: is it an end keyword?
      YES → trigger summary flow
      NO  → normal processing
          → Start/reset inactivity timer (10 min)
          → Assign roles
          → Get agent responses
          → Anti-pattern detection (if turn >= 3 and turn % 2 == 0)
          → Classify responses (anti-sycophancy)
          → Send to Telegram
          → Check: turn count >= session_max_turns?
              YES → trigger summary flow
              NO  → wait for next message

Inactivity timer fires (10 min no messages)
  → trigger summary flow

Summary flow:
  1. Generate gist via LLM (200-300 words)
  2. Determine outcome + confidence
  3. Save markdown to sessions/
  4. Write metadata to brain.db
  5. Post summary to Telegram group
  6. Check consolidation threshold
      → If topic has 5+ sessions → run Layer 4 consolidation
  7. Reset router state
```

---

## 7. Configuration Additions (council.yaml)

```yaml
memory:
  db_path: data/brain.db
  session_timeout_ms: 600000          # 10 min inactivity timeout
  end_keywords:
    - 結束
    - done
    - 結論
    - wrap up
    - 總結
  archive_threshold: 30               # trigger forgetting above this count
  archive_bottom_percent: 20          # forget bottom 20% by retrieval score
  consolidation_threshold: 5          # consolidate after 5+ same-topic sessions

anti_pattern:
  enabled: true
  detection_model: claude-haiku-4-5-20251001
  start_after_turn: 3
  detect_every_n_turns: 2
```

---

## 8. Files to Create or Modify

### New files:
- `src/memory/db.ts` — SQLite database setup, migrations, CRUD operations
- `src/memory/tracker.ts` — Usage frequency tracking (Layer 3)
- `src/memory/consolidator.ts` — Episodic→semantic consolidation (Layer 4)
- `src/memory/pruner.ts` — Adaptive forgetting (Layer 2)
- `src/memory/lifecycle.ts` — Session end detection + summary trigger orchestration
- `src/council/pattern-detector.ts` — Anti-pattern detection (4 patterns)

### Modified files:
- `src/types.ts` — Add MemoryRecord, Pattern, PhaseConfig types
- `src/config.ts` — Parse new memory + anti_pattern config sections
- `src/memory/loader.ts` — Replace flat loading with progressive disclosure (3-layer)
- `src/memory/session-summary.ts` — Add brain.db writes, confidence tagging
- `src/gateway/router.ts` — Integrate session lifecycle, pattern detection, usage tracking
- `src/worker/agent-worker.ts` — Add `[ref:filename]` instruction to system prompt
- `src/worker/personality.ts` — Add low-confidence warning injection
- `src/index.ts` — Initialize brain.db, inactivity timer
- `config/council.yaml` — Add memory and anti_pattern sections
- `package.json` — Add `better-sqlite3` dependency

---

## 9. Design Decisions Log

| Decision | Choice | Alternatives | Rationale |
|----------|--------|-------------|-----------|
| Storage backend | SQLite metadata + markdown content | Pure filesystem; full SQLite | Hybrid: queryable metadata + human-readable content |
| Anti-pattern intervention | Silent injection | Public alerts; mixed | Don't interrupt conversation flow; agents adjust naturally |
| Session end trigger | Keywords + timeout + turn count (all) | Any single trigger | Cover all cases: explicit, implicit, and safety net |
| Pattern detection model | Haiku (cheap) | Same model as agents | Cost control — detection prompt is simple classification |
| Detection frequency | Every 2 turns after turn 3 | Every turn; every 3 turns | Balance: catch patterns early without doubling API cost |
| Instinct system | Simplified (pattern table + advisory) | Full ECC instinct evolution | YAGNI — full system needs 47 agents scale; we have 2 |
| Progressive disclosure | 3-layer (search → meta → content) | Flat load all; 2-layer | claude-mem proved 10x token savings; 3 layers is the sweet spot |
