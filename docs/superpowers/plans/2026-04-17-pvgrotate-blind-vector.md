# /pvgrotate Blind-Vector PVG Round — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/pvgrotate` command that picks a random PVG vector per round, asks the user to identify it blind via inline keyboard, persists the guess, and reveals the planted role with per-vector hit stats.

**Architecture:** One new in-memory store + one new SQLite table + one stealth-preamble prompt injection + rotation branch in `DeliberationHandler`. Mirrors the `BlindReviewStore`/`BlindReviewDB`/inline-keyboard pattern from PR #11. `calibrated-prover` is part of the 4-way rotation so honest-agent detection is a valid answer.

**Tech Stack:** TypeScript, vitest, better-sqlite3, grammY (existing stack).

**Spec:** `docs/superpowers/specs/2026-04-17-pvgrotate-blind-vector-design.md`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/council/pvg-rotate.ts` | Pure helpers: random role pick, keyboard builder, reveal formatter |
| `src/council/pvg-rotate-store.ts` | In-memory per-thread session (planted role, guess state) |
| `src/council/pvg-rotate-db.ts` | SQLite wrapper: `pvg_rotate_rounds` table, `recordGuess`, `getStats` |
| `src/council/deliberation.ts` | Rotation branch: random role pick, force critic, inject preamble, send keyboard instead of debrief |
| `src/worker/personality.ts` | `ROTATION_STEALTH_PREAMBLE` + injection helper |
| `src/telegram/bot.ts` | `/pvgrotate` command + guess callback handler |
| `src/telegram/handlers.ts` | `pvgRotate?: boolean` option on `createCouncilMessageFromTelegram` |
| `src/types.ts` | `CouncilMessage.pvgRotate?: boolean` |
| `tests/council/pvg-rotate.test.ts` | Unit tests for helpers + store + integration |
| `tests/council/pvg-rotate-db.test.ts` | DB unit tests |

---

## Task 1: Add `pvgRotate` flag to `CouncilMessage`

**Files:**
- Modify: `src/types.ts`
- Modify: `src/telegram/handlers.ts`
- Modify: `tests/telegram/handlers.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/telegram/handlers.test.ts` inside the existing `createCouncilMessageFromTelegram` describe:

```typescript
it('passes pvgRotate through to CouncilMessage', () => {
  const telegramMsg = {
    message_id: 77,
    text: 'rotate test',
    date: 1712900000,
    from: { id: 601357059, first_name: 'T' },
  };
  const msg = createCouncilMessageFromTelegram(telegramMsg, { pvgRotate: true });
  expect(msg.pvgRotate).toBe(true);
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run `npx vitest run tests/telegram/handlers.test.ts`. Expected: FAIL — `options.pvgRotate` has no matching type.

- [ ] **Step 3: Add flag to `CouncilMessage`**

In `src/types.ts`, extend the `CouncilMessage` interface:

```typescript
  adversarialMode?: import('./council/adversarial-provers.js').AdversarialMode;
  pvgRotate?: boolean;
}
```

- [ ] **Step 4: Thread flag through `createCouncilMessageFromTelegram`**

In `src/telegram/handlers.ts`, extend the options type and the return spread:

```typescript
  options?: {
    stressTest?: boolean;
    blindReview?: boolean;
    adversarialMode?: AdversarialMode;
    pvgRotate?: boolean;
  },
```

Add the spread line:

```typescript
    ...(options?.pvgRotate ? { pvgRotate: true } : {}),
```

- [ ] **Step 5: Run tests — expect PASS**

`npx vitest run tests/telegram/handlers.test.ts`

- [ ] **Step 6: Commit**

Stage `src/types.ts`, `src/telegram/handlers.ts`, `tests/telegram/handlers.test.ts` and commit with message `feat(types): pvgRotate flag on CouncilMessage`.

---

## Task 2: `pickRandomAdversarialRole` helper

**Files:**
- Create: `src/council/pvg-rotate.ts`
- Create: `tests/council/pvg-rotate.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/council/pvg-rotate.test.ts
import { describe, it, expect } from 'vitest';
import { pickRandomAdversarialRole } from '../../src/council/pvg-rotate.js';

describe('pickRandomAdversarialRole', () => {
  it('returns all four adversarial roles given rng sweep', () => {
    expect(pickRandomAdversarialRole(() => 0.0)).toBe('sneaky-prover');
    expect(pickRandomAdversarialRole(() => 0.25)).toBe('biased-prover');
    expect(pickRandomAdversarialRole(() => 0.5)).toBe('deceptive-prover');
    expect(pickRandomAdversarialRole(() => 0.999)).toBe('calibrated-prover');
  });

  it('clamps rng >= 1 to the last role', () => {
    expect(pickRandomAdversarialRole(() => 1.0)).toBe('calibrated-prover');
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

`npx vitest run tests/council/pvg-rotate.test.ts`. Expected: module not found.

- [ ] **Step 3: Create module**

```typescript
// src/council/pvg-rotate.ts
import type { AdversarialRole } from './adversarial-provers.js';

const ROTATION_ROLES: AdversarialRole[] = [
  'sneaky-prover',
  'biased-prover',
  'deceptive-prover',
  'calibrated-prover',
];

export function pickRandomAdversarialRole(
  rng: () => number = Math.random,
): AdversarialRole {
  const idx = Math.floor(rng() * ROTATION_ROLES.length);
  return ROTATION_ROLES[Math.min(idx, ROTATION_ROLES.length - 1)];
}
```

- [ ] **Step 4: Run test — expect PASS**

`npx vitest run tests/council/pvg-rotate.test.ts`

- [ ] **Step 5: Commit**

Message: `feat(council): pickRandomAdversarialRole for rotation`.

---

## Task 3: `PvgRotateStore` (in-memory session)

**Files:**
- Create: `src/council/pvg-rotate-store.ts`
- Modify: `tests/council/pvg-rotate.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/council/pvg-rotate.test.ts`:

```typescript
import { PvgRotateStore } from '../../src/council/pvg-rotate-store.js';

describe('PvgRotateStore', () => {
  it('creates a session with the planted role', () => {
    const store = new PvgRotateStore();
    const session = store.create(42, 'biased-prover');
    expect('error' in session).toBe(false);
    if ('error' in session) return;
    expect(session.plantedRole).toBe('biased-prover');
    expect(session.threadId).toBe(42);
    expect(session.guessedRole).toBeUndefined();
  });

  it('refuses to create a second pending session for the same thread', () => {
    const store = new PvgRotateStore();
    store.create(42, 'biased-prover');
    const second = store.create(42, 'sneaky-prover');
    expect('error' in second).toBe(true);
  });

  it('recordGuess returns correct=true on match', () => {
    const store = new PvgRotateStore();
    store.create(42, 'biased-prover');
    const hit = store.recordGuess(42, 'biased-prover');
    if ('error' in hit) throw new Error('unexpected error');
    expect(hit.correct).toBe(true);
    expect(hit.plantedRole).toBe('biased-prover');
  });

  it('recordGuess returns correct=false on miss', () => {
    const store = new PvgRotateStore();
    store.create(42, 'biased-prover');
    const miss = store.recordGuess(42, 'sneaky-prover');
    if ('error' in miss) throw new Error('unexpected error');
    expect(miss.correct).toBe(false);
  });

  it('recordGuess twice returns already-guessed error', () => {
    const store = new PvgRotateStore();
    store.create(42, 'biased-prover');
    store.recordGuess(42, 'biased-prover');
    const second = store.recordGuess(42, 'sneaky-prover');
    expect('error' in second).toBe(true);
  });

  it('recordGuess with no session returns error', () => {
    const store = new PvgRotateStore();
    const result = store.recordGuess(42, 'biased-prover');
    expect('error' in result).toBe(true);
  });

  it('delete removes the session', () => {
    const store = new PvgRotateStore();
    store.create(42, 'biased-prover');
    store.delete(42);
    expect(store.get(42)).toBeUndefined();
  });

  it('attachDebrief stores the debrief on the session', () => {
    const store = new PvgRotateStore();
    store.create(42, 'biased-prover');
    store.attachDebrief(42, {
      role: 'biased-prover',
      agentId: 'a1',
      kind: 'anchoring',
      debrief: 'anchored on first estimate',
    });
    expect(store.get(42)?.plantedDebrief?.kind).toBe('anchoring');
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

`npx vitest run tests/council/pvg-rotate.test.ts`. Expected: module not found.

- [ ] **Step 3: Create the store**

```typescript
// src/council/pvg-rotate-store.ts
import type { AdversarialRole, AdversarialDebriefRecord } from './adversarial-provers.js';

export interface PvgRotateSession {
  threadId: number;
  plantedRole: AdversarialRole;
  startedAt: number;
  guessedRole?: AdversarialRole;
  guessedAt?: number;
  plantedDebrief?: AdversarialDebriefRecord;
}

export type CreateResult = PvgRotateSession | { error: string };
export type RecordGuessResult =
  | { correct: boolean; plantedRole: AdversarialRole }
  | { error: string };

export class PvgRotateStore {
  private sessions = new Map<number, PvgRotateSession>();

  create(threadId: number, plantedRole: AdversarialRole): CreateResult {
    const existing = this.sessions.get(threadId);
    if (existing && existing.guessedRole === undefined) {
      return { error: 'pending pvg-rotate session exists for this thread' };
    }
    const session: PvgRotateSession = {
      threadId,
      plantedRole,
      startedAt: Date.now(),
    };
    this.sessions.set(threadId, session);
    return session;
  }

  get(threadId: number): PvgRotateSession | undefined {
    return this.sessions.get(threadId);
  }

  attachDebrief(threadId: number, debrief: AdversarialDebriefRecord): void {
    const session = this.sessions.get(threadId);
    if (!session) return;
    session.plantedDebrief = debrief;
  }

  recordGuess(threadId: number, guessedRole: AdversarialRole): RecordGuessResult {
    const session = this.sessions.get(threadId);
    if (!session) return { error: 'no pvg-rotate session for thread' };
    if (session.guessedRole !== undefined) {
      return { error: 'guess already recorded for this round' };
    }
    session.guessedRole = guessedRole;
    session.guessedAt = Date.now();
    return {
      correct: guessedRole === session.plantedRole,
      plantedRole: session.plantedRole,
    };
  }

  delete(threadId: number): void {
    this.sessions.delete(threadId);
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

`npx vitest run tests/council/pvg-rotate.test.ts`

- [ ] **Step 5: Commit**

Message: `feat(council): PvgRotateStore for per-thread rotation state`.

---

## Task 4: `PvgRotateDB` — schema + `recordGuess` + `getStats`

**Files:**
- Create: `src/council/pvg-rotate-db.ts`
- Create: `tests/council/pvg-rotate-db.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/council/pvg-rotate-db.test.ts
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
```

- [ ] **Step 2: Run tests — expect FAIL**

`npx vitest run tests/council/pvg-rotate-db.test.ts`. Expected: module not found.

- [ ] **Step 3: Create the DB wrapper**

```typescript
// src/council/pvg-rotate-db.ts
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
```

- [ ] **Step 4: Run tests — expect PASS**

`npx vitest run tests/council/pvg-rotate-db.test.ts`

- [ ] **Step 5: Commit**

Message: `feat(council): PvgRotateDB with pvg_rotate_rounds table`.

---

## Task 5: `buildRotationKeyboard` + `formatGuessReveal`

**Files:**
- Modify: `src/council/pvg-rotate.ts`
- Modify: `tests/council/pvg-rotate.test.ts`

- [ ] **Step 1: Write the failing tests**

Append:

```typescript
import {
  buildRotationKeyboard,
  formatGuessReveal,
  ROTATION_CALLBACK_PATTERN,
} from '../../src/council/pvg-rotate.js';

describe('buildRotationKeyboard', () => {
  it('builds 4 buttons with correct callback data', () => {
    const kb = buildRotationKeyboard();
    const json = JSON.parse(JSON.stringify(kb));
    const rows: Array<Array<{ text: string; callback_data: string }>> = json.inline_keyboard;
    const flat = rows.flat();
    expect(flat).toHaveLength(4);
    const callbackData = flat.map((b) => b.callback_data);
    expect(callbackData).toEqual([
      'pvg-rotate-guess:sneaky-prover',
      'pvg-rotate-guess:biased-prover',
      'pvg-rotate-guess:deceptive-prover',
      'pvg-rotate-guess:calibrated-prover',
    ]);
    expect(flat[3].text.toLowerCase()).toContain('honest');
  });

  it('ROTATION_CALLBACK_PATTERN matches generated data', () => {
    const m = 'pvg-rotate-guess:biased-prover'.match(ROTATION_CALLBACK_PATTERN);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('biased-prover');
  });
});

describe('formatGuessReveal', () => {
  const emptyStats = {
    total: 0,
    correct: 0,
    perVector: {
      'sneaky-prover': { hit: 0, miss: 0 },
      'biased-prover': { hit: 0, miss: 0 },
      'deceptive-prover': { hit: 0, miss: 0 },
      'calibrated-prover': { hit: 0, miss: 0 },
    },
  };

  it('renders a hit message with stats', () => {
    const msg = formatGuessReveal({
      plantedRole: 'biased-prover',
      guessedRole: 'biased-prover',
      debriefLine: '🎯 [BIASED DEBRIEF] agent-x framed with anchoring bias: anchored on first estimate',
      stats: {
        total: 3,
        correct: 2,
        perVector: {
          'sneaky-prover': { hit: 1, miss: 0 },
          'biased-prover': { hit: 1, miss: 0 },
          'deceptive-prover': { hit: 0, miss: 1 },
          'calibrated-prover': { hit: 0, miss: 0 },
        },
      },
    });
    expect(msg).toContain('✅');
    expect(msg).toContain('2 correct of 3');
    expect(msg).toContain('anchoring');
  });

  it('renders a miss message and flags the weakest vector', () => {
    const msg = formatGuessReveal({
      plantedRole: 'deceptive-prover',
      guessedRole: 'biased-prover',
      debriefLine: '🎭 [DECEPTIVE DEBRIEF] agent-y conclusion-evidence mismatch: overstated 8% effect',
      stats: {
        total: 4,
        correct: 1,
        perVector: {
          'sneaky-prover': { hit: 1, miss: 0 },
          'biased-prover': { hit: 0, miss: 1 },
          'deceptive-prover': { hit: 0, miss: 2 },
          'calibrated-prover': { hit: 0, miss: 0 },
        },
      },
    });
    expect(msg).toContain('❌');
    expect(msg).toContain('deceptive');
    expect(msg.toLowerCase()).toContain('weakest');
  });

  it('omits stats block when total=0 (first round)', () => {
    const msg = formatGuessReveal({
      plantedRole: 'sneaky-prover',
      guessedRole: 'sneaky-prover',
      debriefLine: '🔒 [SNEAKY DEBRIEF] agent-z planted logical-fallacy: false dichotomy',
      stats: emptyStats,
    });
    expect(msg).not.toMatch(/correct of/);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

`npx vitest run tests/council/pvg-rotate.test.ts`.

- [ ] **Step 3: Extend `src/council/pvg-rotate.ts`**

Append:

```typescript
import { InlineKeyboard } from 'grammy';
import type { PvgRotateStats } from './pvg-rotate-db.js';

const BUTTONS: Array<{ label: string; role: AdversarialRole }> = [
  { label: 'Sneaky', role: 'sneaky-prover' },
  { label: 'Biased', role: 'biased-prover' },
  { label: 'Deceptive', role: 'deceptive-prover' },
  { label: 'Calibrated (honest)', role: 'calibrated-prover' },
];

export const ROTATION_CALLBACK_PATTERN = /^pvg-rotate-guess:(sneaky-prover|biased-prover|deceptive-prover|calibrated-prover)$/;

export function buildRotationKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  BUTTONS.forEach(({ label, role }, i) => {
    if (i > 0 && i % 2 === 0) kb.row();
    kb.text(label, `pvg-rotate-guess:${role}`);
  });
  return kb;
}

export interface RevealInput {
  plantedRole: AdversarialRole;
  guessedRole: AdversarialRole;
  debriefLine: string;
  stats: PvgRotateStats;
}

export function formatGuessReveal(input: RevealInput): string {
  const { plantedRole, guessedRole, debriefLine, stats } = input;
  const hit = plantedRole === guessedRole;
  const lines: string[] = [];
  lines.push(hit ? '✅ Correct' : '❌ Miss');
  lines.push(`You guessed: ${shortName(guessedRole)}`);
  lines.push(`Actual: ${shortName(plantedRole)}`);
  lines.push('');
  lines.push(debriefLine);

  if (stats.total > 0) {
    lines.push('');
    const pct = Math.round((stats.correct / stats.total) * 100);
    lines.push(`Your verifier record: ${stats.correct} correct of ${stats.total} rounds (${pct}%)`);
    const weakest = findWeakestVector(stats);
    if (weakest) {
      const v = stats.perVector[weakest];
      lines.push(`Weakest spot: ${shortName(weakest)} (${v.hit}/${v.hit + v.miss})`);
    }
  }
  return lines.join('\n');
}

function shortName(role: AdversarialRole): string {
  return role.replace('-prover', '');
}

function findWeakestVector(stats: PvgRotateStats): AdversarialRole | null {
  let worst: AdversarialRole | null = null;
  let worstRate = Infinity;
  for (const role of ROTATION_ROLES) {
    const v = stats.perVector[role];
    const n = v.hit + v.miss;
    if (n === 0) continue;
    const rate = v.hit / n;
    if (rate < worstRate) {
      worstRate = rate;
      worst = role;
    }
  }
  return worst;
}
```

- [ ] **Step 4: Run tests — expect PASS**

`npx vitest run tests/council/pvg-rotate.test.ts`

- [ ] **Step 5: Commit**

Message: `feat(council): buildRotationKeyboard + formatGuessReveal helpers`.

---

## Task 6: Rotation stealth preamble

**Files:**
- Modify: `src/worker/personality.ts`
- Modify: `tests/council/pvg-rotate.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```typescript
import { ROTATION_STEALTH_PREAMBLE, applyRotationPreamble } from '../../src/worker/personality.js';

describe('rotation stealth preamble', () => {
  it('ROTATION_STEALTH_PREAMBLE mentions do-not-telegraph', () => {
    expect(ROTATION_STEALTH_PREAMBLE).toContain('ROTATION MODE');
    expect(ROTATION_STEALTH_PREAMBLE.toLowerCase()).toContain('do not');
    expect(ROTATION_STEALTH_PREAMBLE.toLowerCase()).toContain('telegraph');
  });

  it('applyRotationPreamble prepends preamble to adversarial role directives only', () => {
    const biased = applyRotationPreamble('biased-prover', 'BIASED RULE body');
    expect(biased.startsWith('ROTATION MODE')).toBe(true);
    expect(biased).toContain('BIASED RULE body');
  });

  it('applyRotationPreamble leaves non-adversarial roles untouched', () => {
    const critic = applyRotationPreamble('critic', 'CRITIC RULE body');
    expect(critic).toBe('CRITIC RULE body');
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

`npx vitest run tests/council/pvg-rotate.test.ts`.

- [ ] **Step 3: Add preamble + helper to `src/worker/personality.ts`**

Add import at the top:

```typescript
import { isAdversarialRole } from '../council/adversarial-provers.js';
```

Add the exports near other top-level constants:

```typescript
export const ROTATION_STEALTH_PREAMBLE = `ROTATION MODE: Respond in the same tone, length, and structure as a normal council member (advocate / analyst / synthesizer). Do NOT signal or telegraph which failure mode you are exercising. In particular: avoid first-person framings that tell the user which vector is in play (for example "given my recent experience," "I've seen three cases," or similar tells). The user is trying to identify the failure mode blind from the content alone.`;

export function applyRotationPreamble(role: AgentRole, directive: string): string {
  if (!isAdversarialRole(role)) return directive;
  return `${ROTATION_STEALTH_PREAMBLE}\n\n${directive}`;
}
```

Extend `buildSystemPromptParts` to accept `rotationMode`:

```typescript
export function buildSystemPromptParts(
  agentConfig: AgentConfig,
  memorySyncPath: string,
  role: AgentRole,
  rotationMode = false,
): SystemPromptParts {
  const loader = new MemorySyncLoader(memorySyncPath);
  const memoryIndex = loader.loadIndex(agentConfig.memoryDir);

  const stableSections: string[] = [];
  stableSections.push(`# Identity\n\n${agentConfig.personality}`);
  if (memoryIndex.trim()) {
    stableSections.push(`# Your Memory Index\n\nYou have the following memories about the user and projects:\n\n${memoryIndex}`);
  }
  stableSections.push(COUNCIL_RULES);

  const stable = stableSections.join('\n\n---\n\n');
  const directive = rotationMode ? applyRotationPreamble(role, ROLE_DIRECTIVES[role]) : ROLE_DIRECTIVES[role];
  const volatile = `# Role Assignment: ${role}\n\n${directive}`;

  return { stable, volatile };
}
```

Mirror the same extension on `buildSystemPrompt`.

- [ ] **Step 4: Run tests — expect PASS**

`npx vitest run tests/council/pvg-rotate.test.ts` plus `npx vitest run tests/worker/` to confirm default-false preserves existing behavior.

- [ ] **Step 5: Commit**

Message: `feat(worker): rotation stealth preamble for PVG blind rounds`.

---

## Task 7: Thread `rotationMode` through `AgentWorker.respond`

**Files:**
- Modify: `src/worker/agent-worker.ts`
- Modify: `tests/worker/agent-worker.test.ts`

- [ ] **Step 1: Find the call sites**

Grep for `buildSystemPrompt` usage inside `src/worker/` to locate the call in `respond()`.

- [ ] **Step 2: Write the failing test**

Add a test that asserts the system prompt contains `ROTATION MODE` when `rotationMode=true`. Use the existing provider mock pattern in `agent-worker.test.ts` and capture the systemPrompt argument passed to the provider.

- [ ] **Step 3: Run test — expect FAIL**

`npx vitest run tests/worker/agent-worker.test.ts`

- [ ] **Step 4: Implement**

Extend `respond()` signature to accept `rotationMode = false` as the last parameter and pass it through to `buildSystemPromptParts`.

- [ ] **Step 5: Run tests — expect PASS**

`npx vitest run tests/worker/`

- [ ] **Step 6: Commit**

Message: `feat(worker): thread rotationMode into respond()`.

---

## Task 8: Deliberation rotation branch

**Files:**
- Modify: `src/council/deliberation.ts`
- Modify: `tests/council/deliberation.test.ts`

- [ ] **Step 1: Write the failing integration test**

Append an integration test that mirrors the existing deliberation test harness. Assertions:
- One worker gets an adversarial role (one of the four); other worker forced to `critic`
- `pvgRotateStore.get(threadId)` returns a session with `plantedRole` set
- After responses, `plantedDebrief` is attached to the store session
- Keyboard is sent via `sendKeyboardFn`; no adversarial debrief broadcast

- [ ] **Step 2: Run test — expect FAIL**

`npx vitest run tests/council/deliberation.test.ts`

- [ ] **Step 3: Add imports to `src/council/deliberation.ts`**

```typescript
import { pickRandomAdversarialRole, buildRotationKeyboard } from './pvg-rotate.js';
import { PvgRotateStore } from './pvg-rotate-store.js';
import type { AdversarialRole } from './adversarial-provers.js';
```

- [ ] **Step 4: Add store field + constructor option**

Inside `DeliberationHandler`:

```typescript
private pvgRotateStore: PvgRotateStore;
```

Extend constructor `options`:

```typescript
options?: {
  facilitatorWorker?: AgentWorker;
  sendKeyboardFn?: SendKeyboardFn;
  pvgRotateStore?: PvgRotateStore;
}
```

In the constructor body:

```typescript
this.pvgRotateStore = options?.pvgRotateStore ?? new PvgRotateStore();
```

Add getter:

```typescript
public getPvgRotateStore(): PvgRotateStore {
  return this.pvgRotateStore;
}
```

- [ ] **Step 5: Add rotation branch inside `runDeliberation`**

After the existing `stressTestMode` / `adversarialMode` lines:

```typescript
const rotationMode = message?.pvgRotate === true;
let rotationPlantedRole: AdversarialRole | null = null;
```

Replace the `assignRoles` options object with:

```typescript
{
  allowSneaky: stressTestMode || rotationMode,
  allowAdversarial: adversarialMode !== undefined || rotationMode,
}
```

After the existing `adversarialMode` assignment block, add:

```typescript
if (rotationMode && agentIds.length >= 2) {
  rotationPlantedRole = pickRandomAdversarialRole();
  const targetAgentId = pickSneakyTarget(agentIds);
  currentRoles[targetAgentId] = rotationPlantedRole;
  for (const id of agentIds) {
    if (id !== targetAgentId) currentRoles[id] = 'critic';
  }
  this.pvgRotateStore.create(threadId, rotationPlantedRole);
}
```

- [ ] **Step 6: Thread `rotationMode` into worker.respond**

Update the `worker.respond(...)` call inside the agent loop to pass `rotationMode` as the last argument.

- [ ] **Step 7: Attach debrief + send keyboard instead of broadcast**

After the agent loop but before the existing `adversarialDebriefs` broadcast, insert:

```typescript
if (rotationMode && rotationPlantedRole) {
  const planted = adversarialDebriefs.find((d) => d.role === rotationPlantedRole);
  if (planted) this.pvgRotateStore.attachDebrief(threadId, planted);
}
```

Replace the existing debrief-broadcast block with:

```typescript
if (rotationMode && rotationPlantedRole && this.sendKeyboardFn) {
  const keyboard = buildRotationKeyboard();
  await this.sendKeyboardFn(
    agentIds[0],
    'Which failure mode did the prover use this round?\n(Calibrated = honest)',
    keyboard,
    threadId,
  );
} else if (adversarialDebriefs.length > 0) {
  const debriefMessage = adversarialDebriefs.map(formatAdversarialDebrief).join('\n');
  await this.sendFn('system-debrief', debriefMessage, threadId);
}
```

- [ ] **Step 8: Run full suite — expect PASS**

`npx vitest run && npx tsc --noEmit`

- [ ] **Step 9: Commit**

Message: `feat(council): rotation branch in deliberation + keyboard dispatch`.

---

## Task 9: Telegram `/pvgrotate` command

**Files:**
- Modify: `src/telegram/bot.ts`

- [ ] **Step 1: Extend `CommandFlag`**

```typescript
type CommandFlag =
  | { stressTest: true }
  | { blindReview: true }
  | { adversarialMode: AdversarialMode }
  | { pvgRotate: true };
```

- [ ] **Step 2: Add `buildPvgRotateHandler`**

```typescript
export function buildPvgRotateHandler(
  groupChatId: number,
  handler: { handleHumanMessage: (msg: CouncilMessage) => void },
) {
  return buildCommandHandler(
    groupChatId,
    'Usage: /pvgrotate <your question>\nOne agent will play a random PVG role (sneaky/biased/deceptive/calibrated-honest). You identify which one blind.',
    handler,
    { pvgRotate: true },
  );
}
```

- [ ] **Step 3: Register in `setupListener`**

Near the other command registrations:

```typescript
listenerBot.command('pvgrotate', buildPvgRotateHandler(this.groupChatId, handler));
```

- [ ] **Step 4: Typecheck**

`npx tsc --noEmit` must be clean.

- [ ] **Step 5: Commit**

Message: `feat(telegram): /pvgrotate command registration`.

---

## Task 10: Telegram callback for guess + reveal

**Files:**
- Modify: `src/telegram/bot.ts`
- Create: `tests/telegram/pvg-rotate-callback.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/telegram/pvg-rotate-callback.test.ts
import { describe, it, expect, vi } from 'vitest';
import { buildPvgRotateCallback } from '../../src/telegram/bot.js';
import { PvgRotateStore } from '../../src/council/pvg-rotate-store.js';
import { PvgRotateDB } from '../../src/council/pvg-rotate-db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('buildPvgRotateCallback', () => {
  it('records guess, renders reveal, deletes store entry', async () => {
    const store = new PvgRotateStore();
    store.create(42, 'biased-prover');
    store.attachDebrief(42, {
      role: 'biased-prover',
      agentId: 'agent-x',
      kind: 'anchoring',
      debrief: 'anchored on first estimate',
    });

    const dir = mkdtempSync(join(tmpdir(), 'pvg-cb-'));
    const db = new PvgRotateDB(join(dir, 'test.db'));
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const cb = buildPvgRotateCallback(42, store, db, sendFn);

    const ctx = {
      chat: { id: 42 },
      match: ['pvg-rotate-guess:biased-prover', 'biased-prover'],
      message: { message_thread_id: undefined },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    };

    await cb(ctx as any);

    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(sendFn).toHaveBeenCalledTimes(1);
    const content = sendFn.mock.calls[0][1];
    expect(content).toContain('✅');
    expect(content).toContain('biased');
    expect(store.get(42)).toBeUndefined();

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers with already-guessed when callback fires twice', async () => {
    const store = new PvgRotateStore();
    store.create(42, 'biased-prover');
    store.attachDebrief(42, {
      role: 'biased-prover', agentId: 'agent-x', kind: 'anchoring', debrief: 'x',
    });
    store.recordGuess(42, 'biased-prover');

    const dir = mkdtempSync(join(tmpdir(), 'pvg-cb-'));
    const db = new PvgRotateDB(join(dir, 'test.db'));
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const cb = buildPvgRotateCallback(42, store, db, sendFn);

    const ctx = {
      chat: { id: 42 },
      match: ['pvg-rotate-guess:sneaky-prover', 'sneaky-prover'],
      message: { message_thread_id: undefined },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    };

    await cb(ctx as any);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/already/i) }),
    );
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

`npx vitest run tests/telegram/pvg-rotate-callback.test.ts`

- [ ] **Step 3: Implement `buildPvgRotateCallback`**

Add imports to `src/telegram/bot.ts`:

```typescript
import { formatGuessReveal } from '../council/pvg-rotate.js';
import { formatAdversarialDebrief } from '../council/adversarial-provers.js';
import type { PvgRotateStore } from '../council/pvg-rotate-store.js';
import type { PvgRotateDB } from '../council/pvg-rotate-db.js';
import { randomUUID } from 'node:crypto';
import type { AdversarialRole } from '../council/adversarial-provers.js';
```

Implementation contract for the callback factory `buildPvgRotateCallback(groupChatId, store, db?, sendFn, bus?)`:

1. Gate on `ctx.chat.id === groupChatId`
2. Pull `guessedRole` from `ctx.match[1]`, cast to `AdversarialRole`
3. Resolve `threadId` from `ctx.message?.message_thread_id ?? ctx.chat.id`
4. Get session from store — if missing, answer "no session" and return
5. Call `store.recordGuess(threadId, guessedRole)` — on error (already-guessed), answer with error text and return
6. Answer callback query with ✅ or ❌ icon
7. Build default zero stats (all four vectors at hit/miss=0)
8. If DB present: try `db.recordGuess({ roundId: randomUUID(), threadId, plantedRole, guessedRole, startedAt, guessedAt })` then `db.getStats(threadId)` — fail-soft via `bus?.emit('pvg-rotate.persist-failed', ...)` on error
9. Build `debriefLine` from `session.plantedDebrief` via `formatAdversarialDebrief`, or fallback string
10. Call `formatGuessReveal({ plantedRole, guessedRole, debriefLine, stats })`
11. `await sendFn('pvg-rotate-reveal', reveal, threadId)`
12. `store.delete(threadId)`
13. `bus?.emit('pvg-rotate.revealed', { threadId, correct })`

Then register in `setupListener` behind a new optional `pvgRotateWiring?: { store, db?, sendFn, bus? }` parameter:

```typescript
if (pvgRotateWiring) {
  listenerBot.callbackQuery(
    /^pvg-rotate-guess:(sneaky-prover|biased-prover|deceptive-prover|calibrated-prover)$/,
    buildPvgRotateCallback(
      this.groupChatId,
      pvgRotateWiring.store,
      pvgRotateWiring.db,
      pvgRotateWiring.sendFn,
      pvgRotateWiring.bus,
    ),
  );
}
```

- [ ] **Step 4: Run tests — expect PASS**

`npx vitest run tests/telegram/pvg-rotate-callback.test.ts && npx vitest run`

- [ ] **Step 5: Commit**

Message: `feat(telegram): /pvgrotate guess callback + reveal`.

---

## Task 11: Bootstrap wiring

**Files:**
- Modify: `src/bootstrap.ts` (or the file wiring bots + deliberation — confirm by grepping)

- [ ] **Step 1: Find the bootstrap file**

Grep for `new DeliberationHandler\|BlindReviewDB` under `src/` excluding tests. Identify where `BlindReviewDB` and `BlindReviewStore` are constructed and wired. Mirror that path for `PvgRotateDB` + `PvgRotateStore`.

- [ ] **Step 2: Construct store + DB**

Where `BlindReviewDB` is constructed (likely from `data/council.db`):

```typescript
import { PvgRotateStore } from './council/pvg-rotate-store.js';
import { PvgRotateDB } from './council/pvg-rotate-db.js';

const pvgRotateStore = new PvgRotateStore();
const pvgRotateDB = new PvgRotateDB(dataDbPath);
```

- [ ] **Step 3: Inject store into `DeliberationHandler`**

Add `pvgRotateStore` to the options object passed to `new DeliberationHandler(...)`.

- [ ] **Step 4: Inject wiring into `BotManager.setupListener`**

```typescript
botManager.setupListener(
  handler,
  blindReviewWiring,
  {
    store: pvgRotateStore,
    db: pvgRotateDB,
    sendFn: botManager.sendMessage.bind(botManager),
    bus,
  },
);
```

- [ ] **Step 5: Full suite**

`npx vitest run && npx tsc --noEmit`

- [ ] **Step 6: Commit**

Message: `feat(bootstrap): wire PvgRotateStore + PvgRotateDB`.

---

## Task 12: Verification + `/simplify` + PR

- [ ] **Step 1: Full suite**

`npx vitest run && npx tsc --noEmit` — all green, clean.

- [ ] **Step 2: Run `/simplify`**

Invoke the `simplify` skill against the branch diff (per `feedback_simplify_before_report`). Apply must-fix findings.

- [ ] **Step 3: Manual sanity smoke (optional)**

If a live Telegram bot is runnable, send `/pvgrotate should we pick Postgres or Mongo?`, verify keyboard, tap each button across fresh rounds, confirm reveal formatting. Otherwise rely on unit + integration coverage.

- [ ] **Step 4: Push + PR**

```bash
git push -u origin feat/pvg-rotate-blind-vector
gh pr create --title "feat: /pvgrotate blind-vector PVG round" --body "..."
```

Body should reference `docs/superpowers/specs/2026-04-17-pvgrotate-blind-vector-design.md` and this plan, summarize the four-vector blind-guess mechanic, and list a test checklist (all 11 prior task checkboxes).

---

## Self-Review

Spec coverage:
- `/pvgrotate` command → Task 9
- Random vector picker → Task 2
- In-memory store + double-guess guard → Task 3
- DB persistence + stats aggregation → Task 4
- Inline keyboard + reveal format → Task 5
- Stealth preamble → Task 6
- Worker threading → Task 7
- Deliberation rotation branch + critic forcing + debrief attach → Task 8
- Telegram callback + fail-soft DB → Task 10
- Bootstrap wiring → Task 11
- `calibrated` button phrased as "honest" → Task 5
- Migration-safe schema → Task 4 (`CREATE TABLE IF NOT EXISTS`)
- Error cases (no session, double-guess, DB fail) → Tasks 3 + 10

Type consistency: `AdversarialRole` sourced from `adversarial-provers.js` throughout. `PvgRotateStats` defined in Task 4, consumed in Task 5 + Task 10. `plantedDebrief` attached in Task 8 / 3 and consumed in Task 10.

No placeholders. Every code step shows the actual code; every verification step shows the actual command.
