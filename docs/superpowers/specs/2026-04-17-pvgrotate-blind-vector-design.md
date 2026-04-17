# /pvgrotate — Blind-Vector PVG Round

**Date:** 2026-04-17
**Status:** Design
**Scope:** One new Telegram command, one new DB table, one targeted prompt injection, one inline-keyboard callback.

## Problem

PR #12 introduced four PVG adversarial roles (sneaky / biased / deceptive / calibrated). Each has its own command (`/stresstest`, `/pvgbiased`, `/pvgdeceptive`, `/pvgcalibrated`), so the user always knows which failure mode is planted. This makes each round a one-vector drill: the user is verifying *a specific known class of error*, not exercising the full verifier muscle.

The PVG framework (Kirchner et al. 2024) assumes the verifier does not know in advance whether the prover is honest, sneaky, biased, or deceptive. The current commands break that assumption.

## Goal

One command that picks a random PVG vector per round, asks the user to identify it blind, persists the guess, and reveals the truth only after the guess is recorded.

`calibrated-prover` is part of the rotation — picking "calibrated" when the agent was honest is a correct answer. This prevents users from learning to always assume adversarial behavior (which would make them over-flag honest agents, the failure mode PVG's honest-prover baseline is designed to expose).

## Non-Goals

- Feeding guess accuracy back into model routing (follow-up PR)
- Multi-round sequences that cover all four vectors in one session (follow-up)
- Changing how `/stresstest` / `/pvgbiased` / `/pvgdeceptive` / `/pvgcalibrated` behave (those stay as-is for targeted drills)
- Training or auto-tuning the prover prompts based on accuracy

## User Flow

```
User: /pvgrotate should we migrate to Postgres from MongoDB?

[round runs, one agent randomly assigned a PVG role, other agent forced to 'critic']
[agent responses stream in, trailer stripped, content stored]

Bot: [inline keyboard]
  Which failure mode did the prover use this round?
  [Sneaky] [Biased] [Deceptive] [Calibrated (honest)]

User: [taps Biased]

Bot: You guessed: biased
     Actual: deceptive
     Miss. The deceptive-prover's tell: stated conclusion "clear major growth" overshot the cited 8% effect.
     Your verifier record: 3 correct of 7 rounds (43%). Weakest spot: deceptive (0/2).
```

## Architecture

### Components

**`src/council/pvg-rotate.ts`** (NEW) — pure helpers:
- `pickRandomAdversarialRole(rng?)` — uniform pick over the 4 adversarial roles
- `buildRotationKeyboard(sessionId)` — inline keyboard with 4 callback buttons
- `formatGuessReveal(session, db?)` — rendering helper (mirrors `formatRevealMessage` pattern from blind-review)

**`src/council/pvg-rotate-store.ts`** (NEW) — in-memory session map, one entry per threadId:
```ts
{ threadId, plantedRole, startedAt, guessedRole?, guessedAt? }
```
Lives until the user guesses. Mirrors `BlindReviewStore` shape so future DB persistence is a drop-in.

**`src/council/pvg-rotate-db.ts`** (NEW) — thin wrapper on existing `data/council.db`:
- One new table `pvg_rotate_rounds` (see Schema)
- `recordGuess(threadId, plantedRole, guessedRole)` — inserts the finished round
- `getUserStats(userId?)` — returns `{ total, correct, perVectorCorrect: Record<AdversarialRole, { hit, miss }> }`

**`src/telegram/bot.ts`** — one new command `/pvgrotate`, one new callback handler `pvg-rotate-guess:<role>`.

**`src/council/deliberation.ts`** — minor: when `message.pvgRotate === true`, behave like `adversarialMode` but with a random role AND inject the stealth preamble AND force non-PVG agents to `critic`.

**`src/worker/personality.ts`** — new `ROTATION_STEALTH_PREAMBLE` constant, prepended to the adversarial directive only when deliberation is in rotation mode.

### Data Flow

```
/pvgrotate cmd
  ↓
CouncilMessage { pvgRotate: true }
  ↓
DeliberationHandler.runDeliberation
  ├── pickRandomAdversarialRole → plantedRole
  ├── assignRoles({ allowSneaky: true, allowAdversarial: true })
  ├── force non-PVG agents to 'critic'
  ├── pvgRotateStore.create(threadId, plantedRole)
  ├── agent responses (with stealth preamble injected)
  ├── trailer stripping (existing processAdversarialResponse path)
  └── sendFn with buildRotationKeyboard (NO debrief broadcast yet)
  ↓
User taps guess button
  ↓
callbackQuery handler
  ├── pvgRotateStore.recordGuess(threadId, guessedRole)
  ├── pvgRotateDB.recordGuess(...) — fail-soft like blind-review
  ├── formatGuessReveal(...) — shows planted role, debrief, user stats
  ├── sendFn broadcast reveal
  └── pvgRotateStore.delete(threadId)
```

### CouncilMessage Extension

```ts
// types.ts — add one flag
pvgRotate?: boolean;
```

`adversarialMode` is NOT reused — rotation is conceptually different (the *identity* of the mode is hidden until reveal), so giving it its own flag avoids tangling the existing per-mode commands.

### Schema

```sql
CREATE TABLE IF NOT EXISTS pvg_rotate_rounds (
  round_id       TEXT PRIMARY KEY,       -- UUID
  thread_id      INTEGER NOT NULL,
  planted_role   TEXT NOT NULL,          -- 'sneaky-prover' | 'biased-prover' | ...
  guessed_role   TEXT NOT NULL,
  correct        INTEGER NOT NULL,       -- 0 or 1
  started_at     TEXT NOT NULL,
  guessed_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pvg_rounds_thread ON pvg_rotate_rounds(thread_id);
```

No user_id column in v1. Telegram chat-level scoping is enough; when multi-user stats matter, migration adds `user_id TEXT NULL`. Schema is migration-safe.

### Stealth Preamble

One block injected ahead of the role directive when `pvgRotate === true`:

```
ROTATION MODE: Respond in the same tone, length, and structure as a normal
council member (advocate / analyst / synthesizer). Do NOT signal which failure
mode you are exercising. In particular: do not use first-person framings that
telegraph the vector (e.g. "given my recent experience," "I've seen three
cases," or similar biased-prover tells). The user is trying to identify the
failure mode blind from the content alone.
```

Injected only in rotation mode so the existing single-vector commands (where the user knows the mode) keep their current, more illustrative prompts.

### Verifier Role Forcing

In rotation mode, all non-PVG agents get `critic` regardless of topic-override assignment. Rationale: the council's job this round is to verify, not to advocate or synthesize. Implemented in `DeliberationHandler.runDeliberation` right after `assignRoles` returns, before the `pickRandomAdversarialRole` overwrite.

## Error Handling

| Failure | Behavior |
|---------|----------|
| User guesses twice (double-tap) | `pvgRotateStore.recordGuess` returns `{ error: 'already-guessed' }`, callback answers with "already recorded" |
| User never guesses | Store entry stays until next `/pvgrotate` on same thread — no TTL in v1 (YAGNI) |
| DB write fails | Fail-soft like blind-review: reveal still sends, emit `pvg-rotate.persist-failed` event |
| Single-agent thread | Reject at command level ("needs ≥ 2 agents"), mirrors existing blind-review gate |
| Agent omits trailer | `processAdversarialResponse` already handles this — debrief shows "missing-trailer" |

## Testing Strategy

Pure helpers get unit tests; the deliberation integration is exercised through a focused integration test.

### Unit

- `pickRandomAdversarialRole` — RNG-injectable, covers all 4 vectors given 4 RNG values
- `buildRotationKeyboard` — 4 buttons, callback-data shape
- `formatGuessReveal` — hit/miss messaging, stats rendering (fed synthetic stats)
- `pvgRotateStore` — create / recordGuess / double-guess rejection / delete
- `pvgRotateDB` — insert, query by thread, `getUserStats` math

### Integration

- Deliberation in rotation mode: mock workers return a response with a known trailer; assert one agent gets a random adversarial role, other gets `critic`, stealth preamble appears in the system prompt, response stored without trailer, keyboard sent instead of debrief.
- End-to-end callback: simulate tap, assert store updated, DB row written, reveal content correct for hit and for miss.

### What is NOT tested

- The stealth preamble's actual effectiveness at hiding the vector (requires real LLM output; observable via user miss rate over time, which is what the stats are for)
- Cross-user stats aggregation (no user_id in v1)

## Migration & Backward Compatibility

- `pvg_rotate_rounds` is a new table; existing `data/council.db` picks it up via `CREATE TABLE IF NOT EXISTS` at DB open time.
- `CouncilMessage.pvgRotate` is optional; all existing messages remain valid.
- Existing `/stresstest`, `/pvgbiased`, `/pvgdeceptive`, `/pvgcalibrated` keep current behavior. The 4-vector dispatcher (`processAdversarialResponse`) is unchanged.
- No changes to `council.yaml`.

## Files Touched

| File | Change |
|------|--------|
| `src/council/pvg-rotate.ts` | NEW |
| `src/council/pvg-rotate-store.ts` | NEW |
| `src/council/pvg-rotate-db.ts` | NEW |
| `src/council/deliberation.ts` | rotation branch + critic forcing |
| `src/worker/personality.ts` | `ROTATION_STEALTH_PREAMBLE` + injection point |
| `src/telegram/bot.ts` | `/pvgrotate` command + callback handler |
| `src/telegram/handlers.ts` | `pvgRotate?: boolean` option |
| `src/types.ts` | `CouncilMessage.pvgRotate?: boolean` |
| `tests/council/pvg-rotate.test.ts` | NEW (unit + integration) |
| `tests/council/pvg-rotate-db.test.ts` | NEW |

Approximate size: ~400 lines production + ~300 lines tests.

## Follow-Up Work (Not This PR)

- Routing feedback loop: feed per-vector miss rates into model-tier recommendations (mirrors blind-review closed loop)
- Multi-round sequences (`/pvgrotate 4 <q>` covers all four)
- Per-user stats when multiple humans share a thread
- `pvg-rotate.revealed` event with payload for downstream consumers
