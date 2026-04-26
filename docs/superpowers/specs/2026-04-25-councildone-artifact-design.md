# v0.5.2.a `/councildone` Artifact Synthesizer — Design

**Version target**: v0.5.2.a
**Theme**: Long-running council sessions — closing primitive (Anthropic *Harness Design for Long-Running Applications*, 2026-04)
**Roadmap anchor**: `agent-council-ROADMAP.md` §0.5.2 (split — see Section 0)
**Date**: 2026-04-25
**Supersedes**: Earlier 2026-04-25 `/councilcontract` brainstorm (rejected after Codex review surfaced 15 P1 findings; see `.codex-review-2026-04-25-councilcontract.md`)
**Spec review iterations**: rewritten 2026-04-25 after Codex spec-level review (`.codex-review-2026-04-25-v052a-design-doc.md`) returned 15 P1 + 2 P2. All findings closed inline; resolution log in §17.

---

## 0. Scope split (2026-04-25, post-Codex review)

The original v0.5.2 roadmap entry described a single feature: `/councilcontract` — pre-discussion contract negotiation, with an evaluator agent grading the transcript against the contract at `/councildone`. An adversarial Codex review (xhigh, 2026-04-25, session `019dc35a-608b-7201-9e45-96c59f654247`) returned 15 P1 findings, of which the most structural were:

- The repo has no canonical artifact for an evaluator to grade — only chat turns and a lightweight conversational facilitator summary.
- The proposed schema keyed on abstract `session_id`, but the runtime keys on numeric `threadId` / segment.
- Proposed listener-driven evaluator loop would reopen the v0.5.2 P1-B race fixed in `4d6dad3` (single-owner mutation rule, `feedback_listener_mutation_antipattern.md`).

Decision: split v0.5.2 in two.

- **v0.5.2.a (this spec)** — artifact synthesizer at `/councildone`. User gets a structured markdown decision memo. Independently shippable.
- **v0.5.2.b (deferred)** — contract layer on top of v0.5.2.a. Re-brainstorm from scratch when v0.5.2.a is in production. The Codex finding file `.codex-review-2026-04-25-councilcontract.md` is preserved as starting context.

v0.5.2.a does NOT add forward-compat hooks for v0.5.2.b. ALTER TABLE is a normal sqlite migration and the v0.5.2.b design may not even use this schema.

## 1. Problem

`/council <topic>` runs an open-ended deliberation. Users sometimes report "I got discussion, no decision." The system has chat turns and a conversational facilitator summary asking whether to continue. Nothing user-visible says "this is the conclusion of this council." There is no addressable artifact to:

- Hand off ("paste this into the team channel").
- Compare across councils ("which two councils came to opposite conclusions?").
- Grade in v0.5.2.b ("did this discussion satisfy the contract?").

## 2. Goal

Ship a user-triggered `/councildone [preset]` command that:

1. Seals the current segment (no further messages append; subsequent user input opens a new segment, like `/councilreset`).
2. Generates a structured markdown artifact via a dedicated synthesizer worker reading only the just-sealed segment's messages.
3. Persists the artifact to a new `council_artifacts` table with a thread-local sequence id.
4. Returns a short inline summary (preset, thread-local id, first 200 chars of `## TL;DR`) and exposes full content via `/councilshow <thread-local-id>`.
5. Handles in-flight, blind-review, reset, and classification states correctly via a guard taxonomy split into transient (wait) and persistent (reject-with-instruction).

**Non-goals** (explicit, enforced):

- Contract negotiation, evaluator agent, contract grading. Deferred to v0.5.2.b.
- Idle-timeout artifact, mid-session snapshot, reset-triggered artifact. Only `/councildone` triggers.
- Regenerate / `--force` / `--retry` flags. v0.5.3+ if real demand surfaces.
- Multiple artifacts per segment with different presets. `UNIQUE(thread_id, segment_index)` is the invariant.
- Cross-segment / cross-thread artifact synthesis. Single segment, single thread.
- Forward-compat columns for v0.5.2.b contract integration.
- Fallback "transcript dump" on synthesis failure. Hard fail with error message.
- Telegram MarkdownV2 rendering. Plain text surface. (Future enhancement, not v0.5.2.a.)

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  /councildone [preset]                                          │
│      │                                                          │
│      ▼                                                          │
│  CommandHandler (CLI: cli-commands whitelist;                   │
│                  Telegram: bot.command before catch-all)        │
│      │                                                          │
│      ▼                                                          │
│  GuardCheck                                                     │
│    transient (wait, will clear soon):                           │
│      deliberationInFlight, pendingClassifications, resetInFlight│
│    persistent (reject-with-instruction):                        │
│      blindReviewPending → "請先 /blindreview reveal 或           │
│                            /cancelreview"                       │
│    empty segment → "本 segment 尚無討論"                         │
│      │                                                          │
│      ▼                                                          │
│  ArtifactService.synthesize(threadId, preset)        ◄── DIRECT │
│    A. RE-CHECK transient/persistent guards                AWAIT,│
│       (defense against race between command-               NOT  │
│       handler GuardCheck above and synthesize call)       VIA   │
│    B. fast-path: cached + cached.segment_index ==         BUS   │
│       lastSealedSegmentIndex(both tables) +                     │
│       currentSegment.messages.length === 0 →                    │
│       return cached (no LLM call, no mutation)                  │
│    C. else require live (unsealed) currentSegment               │
│       with messages.length > 0                                  │
│    1. set synthesisInFlight = true                              │
│    2. read transcript = currentSegment.messages (no seal yet)   │
│    3. invoke artifact synthesizer via                           │
│       provider.chat() DIRECTLY (NOT AgentWorker.respond,        │
│       which would inject personality.ts markdown ban via        │
│       buildSystemPromptParts)                                   │
│       - retry policy: see §8                                    │
│    4. parse TL;DR; if missing → hard fail (no retry)            │
│    5. seal currentSegment in-memory (assigning segment_index    │
│       from segment-counter source — see §8)                     │
│    6. INSERT council_artifacts row                              │
│       (if INSERT throws → unsealCurrentSegment to rollback      │
│        in-memory mutation; SQLite txn alone won't undo it)      │
│    7. openNewSegment(threadId)                                  │
│    8. emit 'artifact.created' (broadcast only — listeners       │
│       MUST NOT mutate session state)                            │
│    9. unset synthesisInFlight                                   │
│    On any failure between step 1-4: synthesisInFlight cleared,  │
│    segment NOT sealed, no row inserted. User can retry.         │
│    On INSERT failure (step 6): seal rolled back via             │
│    unsealCurrentSegment, lock cleared.                          │
│      │                                                          │
│      ▼                                                          │
│  Adapter renders inline summary:                                │
│    "Artifact #N (decision) — TL;DR: <first 200 chars>"          │
│                                                                 │
│  /councilshow <thread-local-id>                                 │
│    SELECT ... WHERE thread_id = ? AND thread_local_seq = ?      │
│    chunkMarkdown(content_md, 4096) → adapter sends chunks       │
└─────────────────────────────────────────────────────────────────┘
```

Single-owner mutation rule (v0.5.2 P1-B lesson): `ArtifactService.synthesize` is the sole owner of segment seal + artifact insert. EventBus is broadcast only.

## 4. Data model

```sql
CREATE TABLE IF NOT EXISTS council_artifacts (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id                   INTEGER NOT NULL,
  segment_index               INTEGER NOT NULL,    -- shared counter with session_reset_snapshots
  thread_local_seq            INTEGER NOT NULL,    -- user-facing id within thread
  preset                      TEXT NOT NULL,       -- 'universal' | 'decision'
  content_md                  TEXT NOT NULL,
  created_at                  TEXT NOT NULL,       -- ISO 8601 (matches reset/PVG style)
  synthesis_model             TEXT,
  synthesis_token_usage_json  TEXT,
  UNIQUE(thread_id, segment_index),
  UNIQUE(thread_id, thread_local_seq)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_thread
  ON council_artifacts(thread_id, created_at DESC);
```

Append-only (no UPDATE on existing rows). Migration is additive; no changes to other tables.

**Segment-index source** — both seal paths share one formula:

```
sealedIndices = session_reset_snapshots.segment_index for thread
             ∪ council_artifacts.segment_index for thread
nextSegmentIndex = sealedIndices.length > 0
  ? max(sealedIndices) + 1
  : handler.getSegments(threadId).length - 1   // fresh-thread fallback
```

This formula MUST be applied at **both** seal points to keep the counter monotonic across process restarts:

- **`/councildone` seal** in `ArtifactService.synthesize` (§8 commit phase). New code; uses the formula from day one.
- **`/councilreset` seal** in `src/council/session-reset.ts:172`. The current v0.5.1 implementation only consults `session_reset_snapshots`, which is correct in isolation but breaks once `council_artifacts` exists: after process restart following an artifact-seal but before any reset snapshot, in-memory segment state is gone, the reset DB is empty, and reset would fall back to index 0 — colliding with the artifact's `segment_index`. Spec §12 lists `session-reset.ts` as modified for this reason; the change is to swap the single-table query for the cross-table union shown above. Extracting the union into a small helper reachable from both modules (or duplicating it with a comment pointing at the other site) is acceptable; the invariant is that adding a third seal primitive in the future requires updating this single source of truth.

A `(thread_id, segment_index)` lookup is unambiguous regardless of which command sealed the segment.

**Event payload** (extends `EventMap` in `src/events/bus.ts`):

```ts
'artifact.created': {
  threadId: number;
  segmentIndex: number;
  threadLocalSeq: number;
  preset: 'universal' | 'decision';
}
```

Listeners MUST be read-only (logging / metrics). The `EventBus.emit` does not await async listeners (`src/events/bus.ts:63`), so any listener that mutates session state would reopen the v0.5.2 P1-B race. This is a project-wide convention enforced by code review, not by the bus implementation. Test invariant 11 (added below) verifies no `artifact.created` listener inside this feature mutates anything.

**Helper queries** added to the artifact DB layer:

```ts
// Returns the LATEST artifact for (thread_id, preset), i.e.
// `SELECT * FROM council_artifacts
//  WHERE thread_id = ? AND preset = ?
//  ORDER BY segment_index DESC
//  LIMIT 1`.
// Latest-by-segment_index is contractually required: cache invalidation
// (§8 fast-path) compares this row's segment_index against
// lastSealedSegmentIndex, so any older universal artifact must NEVER be
// returned. (thread_local_seq DESC tiebreak is unnecessary because
// (thread_id, segment_index) is UNIQUE, see §4 schema.)
artifactDb.findByThreadPreset(threadId, preset): ArtifactRow | null

artifactDb.findByThread(threadId): ArtifactRow[]
artifactDb.maxThreadLocalSeq(threadId): number | null
artifactDb.insert(row): ArtifactRow
artifactDb.deleteById(id): void   // used only by openNewSegment rollback in §8
```

**Cross-table sealed-segment helper** (lives on `ArtifactService`, NOT on `artifactDb`, because it joins reset and artifact tables):

```ts
// Returns the largest segment_index sealed for this thread, considering
// BOTH `session_reset_snapshots` (sealed by /councilreset) AND
// `council_artifacts` (sealed by /councildone), or null if the thread
// has no sealed segments. This is the correct comparand for fast-path
// cache invalidation: the cached artifact is only fresh if it covers
// the latest sealed segment from any source.
ArtifactService.lastSealedSegmentIndex(threadId): number | null
// Implementation:
//   const a = artifactDb.findByThread(threadId).map(r => r.segment_index);
//   const r = resetDb.listSnapshotsForThread(threadId).map(s => s.segmentIndex);
//   const all = [...a, ...r];
//   return all.length > 0 ? Math.max(...all) : null;
```

This intentionally re-uses the same data sources as the §8 commit-phase `sealedIndices` computation (which assigns the next segment index), so cache invalidation and segment-index assignment cannot drift apart. If a future segment-sealing primitive is added, both must be updated together.

## 5. Worker model changes

`src/types.ts` — introduce a named `WorkerRoleType` alias (currently `AgentConfig.roleType` is an inline union) and extend it. **The field stays optional** — existing config files and test fixtures rely on `role_type` being omitted to mean "peer" (the v0.5.1 implicit default), and changing the type to required would break them at type-check time.

```ts
export type WorkerRoleType = 'peer' | 'facilitator' | 'artifact-synthesizer';

export interface AgentConfig {
  // ...
  roleType?: WorkerRoleType;        // optional; stays undefined at load-time, effectiveRoleType() applies 'peer' default at use sites
  // ...
}
```

`src/index.ts` — `peerWorkers` filter explicitly excludes both non-peer roles. Use a small helper or inline-default to handle the optional field, treating `undefined` as `'peer'`:

```ts
const effectiveRoleType = (w: AgentConfig): WorkerRoleType => w.roleType ?? 'peer';

const peerWorkers = workers.filter(w => {
  const rt = effectiveRoleType(w);
  return rt !== 'facilitator' && rt !== 'artifact-synthesizer';
});
```

Same convention applies wherever the spec compares `roleType === 'artifact-synthesizer'` — including the `agents.find(...)` extraction in `src/index.ts` for `ArtifactService` construction (§12) — wrap with `effectiveRoleType` rather than reading `roleType` directly.

Naming note: `AgentRole.synthesizer` already exists as a per-round role assignable to peer workers (`src/types.ts:5`). The new `WorkerRoleType` is hyphenated (`artifact-synthesizer`) to avoid the collision. Test isolation must check by `roleType`, not by `assignedRole === 'synthesizer'`.

**Invocation API — direct `provider.chat()`, no `AgentWorker`**:

The actual provider interface (`src/types.ts:157`) is:

```ts
interface LLMProvider {
  readonly name: string;
  chat(messages: ProviderMessage[], options: ChatOptions): Promise<ProviderResponse>;
  summarize(text: string, model: string): Promise<string>;
  estimateTokens(messages: ProviderMessage[]): number;
}

interface ChatOptions {
  model: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt: string;
  systemPromptParts?: SystemPromptPart[];
  thinking?: ThinkingConfig;
}
```

There is no `signal` / `timeout` field on `ChatOptions`. There is no `provider.invoke()` method. The artifact synthesizer therefore:

1. Constructs `ChatOptions` with `systemPrompt` set to the artifact-specific prompt directly. The `personality.ts` markdown ban is injected by `buildSystemPromptParts` inside `AgentWorker.respond`, NOT inside `provider.chat`. Skipping `AgentWorker` skips the ban automatically. No bypass flag needed; just don't go through the worker.

2. Wraps the `provider.chat(...)` promise in a caller-side `Promise.race` timeout (no AbortSignal threading required; existing providers do not accept one).

New file `src/council/artifact-prompt.ts`:

```ts
import type { ProviderMessage, ChatOptions } from '../types.js';

export function buildArtifactPrompt(
  preset: 'universal' | 'decision',
  transcript: CouncilMessage[],
  modelName: string
): { messages: ProviderMessage[]; options: ChatOptions };
```

The returned `options.systemPrompt` is the artifact-specific instruction (TL;DR-mandatory, preset-specific body sections). `options.maxTokens` set explicitly (~3000); `options.temperature` low (0.2-0.3). No `systemPromptParts` set, so no markdown ban gets injected.

New file `src/council/artifact-invoke.ts`:

```ts
import type { LLMProvider, ProviderResponse } from '../types.js';

export class ProviderTimeoutError extends Error {
  constructor(public timeoutMs: number) { super(`Provider call exceeded ${timeoutMs}ms`); }
}

// Caller-side timeout via Promise.race. Underlying fetch is NOT cancelled
// (existing providers don't accept AbortSignal). On timeout, the underlying
// promise continues running until provider's own timeout (CustomProvider: 60s)
// — wasted tokens but bounded.
//
// CRITICAL: `clearTimeout` is called in `finally` so that on the success
// path (provider.chat resolves before the timeout) the scheduled timer is
// cancelled immediately. Without this, every successful synthesis would
// leave a live timer for up to `perAttemptTimeoutMs` (30s default), which
// keeps the Node event loop alive and causes `process.exit(0)`-style CLI
// flows and short test runs to hang waiting for the timer to fire.
//
// KNOWN LIMITATION (concurrent retry storm):
// Because `provider.chat` is uncancellable from the caller, when a hung
// provider triggers `ProviderTimeoutError` and `invokeWithRetry` starts
// the next attempt, the previous request keeps running in the background
// until the SDK or the upstream service times out. Worst case under
// `MAX_ATTEMPTS = 4` with all attempts timing out at 30s:
//   - up to 4 concurrent in-flight requests against the same provider
//   - up to 4 × per-attempt token cost charged to the account
//   - rate-limit headroom consumed by the orphaned attempts (especially
//     OpenAI/Claude tier-based limits)
// The caller-visible bound is still ~127s wall-clock (4×30s timeouts +
// 1s+2s+4s sleeps) before `SynthesisRetryExhaustedError` surfaces; the
// background traffic does NOT extend the bound, only the cost surface.
//
// We accept this in v0.5.2.a because:
//   1. It only fires when the provider is ALREADY pathologically slow
//      (each attempt has to actually exceed 30s — fast successes never
//      stack), so it's an outage symptom, not a steady-state cost.
//   2. The proper fix requires threading `AbortSignal` through the
//      `LLMProvider.chat` interface to all four provider implementations
//      (Claude/OpenAI/Google/Custom), each with its own SDK quirks; this
//      is its own change, deferred to v0.5.3+.
//   3. CustomProvider already has its own internal 60s timeout that
//      bounds the orphan even without caller cancellation.
// The v0.5.3+ AbortSignal threading is the recommended follow-up.
export async function invokeProviderForArtifact(
  provider: LLMProvider,
  messages: ProviderMessage[],
  options: ChatOptions,
  perAttemptTimeoutMs: number
): Promise<ProviderResponse> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      provider.chat(messages, options),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new ProviderTimeoutError(perAttemptTimeoutMs)),
          perAttemptTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
```

`ArtifactService` is constructed (in `src/index.ts`, after worker pool init) with the `AgentConfig` of the worker whose `roleType === 'artifact-synthesizer'` — call this `synthesizerConfig`. At synthesis time it calls `createProvider(synthesizerConfig.provider)` from `src/worker/providers/factory.ts` (the actual export is `createProvider(providerName: string)`, not `providerFactory.create(...)`), then calls `invokeProviderForArtifact()`. Model name is read from `synthesizerConfig.model`. We deliberately keep an `AgentConfig` reference rather than an `AgentWorker` reference because `AgentWorker.config` is private; storing the config directly avoids an artificial accessor on `AgentWorker`.

**One-line CustomProvider fix** (`src/worker/providers/custom.ts:41`): currently throws `new Error('Custom provider error: ${res.status} ...')` which loses the status. Change to attach `.status`:

```ts
if (!res.ok) {
  const err = Object.assign(
    new Error(`Custom provider error: ${res.status} ${await res.text()}`),
    { status: res.status }
  );
  throw err;
}
```

This makes CustomProvider's transient errors (429/5xx) classifiable by `isHardFail` the same way as OpenAI/Claude SDK errors. Strictly additive — existing callers ignoring `.status` continue to work; new callers (`isHardFail`) read it.

**Required output structure** (synthesizer prompt enforces; parser validates):

```
## TL;DR
<2-3 sentence conclusion>

<preset-specific body>
```

Preset bodies:

- **universal**: `## Discussion`, `## Open questions`, `## Suggested next step`
- **decision**: `## Options considered`, `## Recommended option`, `## Trade-offs`, `## Suggested next step`

The TL;DR section is mandatory and parsed via regex `/(?:^|\n)## TL;DR\s*\n+([^\n][\s\S]*?)(?=\n## |$)/`. Notes:

- JavaScript's `RegExp` has no `\Z` anchor; the literal sequence is treated as `Z` (a future TL;DR containing the letter `Z` would otherwise be truncated).
- We do NOT use the `m` flag because `m` makes `$` mean "end of any line", which would stop the lookahead at the first newline. Without `m`, `$` means end-of-string, which is what we want for the "no further headings" terminator.
- We do NOT use the `s` flag; the body class is `[\s\S]*?` instead of `.*?`, which matches across newlines without depending on the dotAll flag.
- The leading `(?:^|\n)` substitutes for line-start `^` semantics that `m` would have provided, so `## TL;DR` must be at the very start of the artifact OR immediately follow a newline (i.e., it must be its own line, not a substring of another line).

If the regex does not match the synthesizer output, the call **hard fails with `MalformedArtifactError` after exactly 1 attempt** (no retry — malformed output indicates prompt-level bug, not transient error). User sees "artifact synthesis produced malformed output (TL;DR section missing); please retry `/councildone`". Inline summary extractor reads first 200 chars of TL;DR section content (post-regex match group 1, trimmed).

## 6. Command routing

CLI (`src/adapters/cli-commands.ts`):
- Add `councildone` and `councilshow` to whitelist.
- `cli-dispatch` routes to `ArtifactService.synthesize` (done) or `ArtifactService.fetchByThreadLocalSeq` (show).

Telegram (`src/telegram/bot.ts`):
- `bot.command('councildone', ...)` and `bot.command('councilshow', ...)` registered BEFORE catch-all message handler.
- Both resolve `threadId` via `resolveTelegramThreadId(ctx.message)` (`src/telegram/handlers.ts:43`), which returns `ctx.message.message_thread_id ?? 0`. **Do NOT use `ctx.chat.id`**: in plain Telegram groups `chat.id` is the group-level id (not 0) and would create a different per-thread session key from the one used by ordinary messages, `/councilreset`, and `/councilhistory` — `/councildone` would synthesize against an empty parallel thread instead of the active discussion. In forum-topic groups the divergence is even more visible: `chat.id` is the group, `message_thread_id` is the topic, and missing the thread id means `/councilshow` cannot find topic-scoped artifacts. Pattern lives at `bot.ts:147 / :175 / :191 / :219 / :252` (existing reset / blind-review / PVG / critique handlers all use it); the new `councildone` / `councilshow` handlers must follow the same call.

`/councildone` argument parsing (after stripping leading slash + command name + whitespace):
- Empty (no arg) → preset = `universal`
- Exactly `universal` → preset = `universal`
- Exactly `decision` → preset = `decision`
- Anything else (including extra args after preset, e.g. `/councildone decision foo`) → reject with "unknown preset, accepted: universal | decision"
- Trailing whitespace tolerated; case-sensitive (`Decision` rejected)

`/councilshow` argument parsing:
- Required arg matches regex `^[1-9]\d{0,9}$` (1-10 digit positive integer, no leading zero, no decimal, no negative)
  - Accepts: `1`, `42`, `9999999999`
  - Rejects: `0`, `-1`, `3.0`, `003`, `99999999999` (11 digits, exceeds JS MAX_SAFE_INTEGER for our purposes)
- Missing arg, non-matching arg, or extra args (e.g. `/councilshow 3 4`) → reject with "/councilshow <id>，例：/councilshow 3"
- Numeric value parsed via `parseInt(arg, 10)` after regex passes

## 7. Concurrency & guards

**Transient guards** (state clears within seconds; user told to wait):

| Flag | Source | Message |
|---|---|---|
| `deliberationInFlight` | `deliberation.ts:73` | 「本輪議論進行中，請等本輪結束再下 /councildone」 |
| `pendingClassifications.size > 0` | `deliberation.ts:73` | 「訊息分類處理中，請稍後再下 /councildone」 |
| `resetInFlight` | `session-reset.ts:100` | 「reset 進行中，請等 reset 完成」 |

**Persistent guards** (state requires explicit user action to clear):

| Flag | Source | Message |
|---|---|---|
| `blindReviewPending` | `deliberation.ts:241` | 「進行中的 blind review 必須先處理：/blindreview reveal 或 /cancelreview」 |

**Synthesis lock — bidirectional**:

`synthesisInFlight` is a per-thread flag owned by `DeliberationHandler` (in `src/council/deliberation.ts`), exposed via `setSynthesisInFlight(threadId, value)` and `isSynthesisInFlight(threadId)`. Storing it on the handler (parallel to existing `resetInFlight` / `deliberationInFlight` flags on the same handler) is what makes the lock visible across modules — `ArtifactService`, `runDeliberation`, and `SessionReset` all read the same flag through the handler. A local `Set<number>` inside `ArtifactService` would not satisfy the bidirectional requirement.

The flag is set at start of `ArtifactService.synthesize` and unset on completion (success or failure). It is enforced **bidirectionally** so that nothing else mutates the segment while synthesis reads it:

- `ArtifactService.synthesize` rejects with `SynthesisAlreadyRunning` if `handler.isSynthesisInFlight(threadId)` returns true on entry.
- `runDeliberation` (in `src/council/deliberation.ts`) checks `this.isSynthesisInFlight(threadId)` alongside its existing `resetInFlight` check and rejects new agent rounds with the standard "transient: please wait" message.
- `SessionReset.reset` checks `handler.isSynthesisInFlight(threadId)` and refuses with persistent-style message: 「synthesis 進行中，請稍候再下 `/councilreset`」 (synthesis is bounded by the per-attempt timeout × max attempts ≈ 127 seconds worst case, so user wait is bounded).
- `ArtifactService.synthesize` symmetrically refuses if `resetInFlight` or `deliberationInFlight` is already set (see Transient guards table above; this is the existing direction).

Pattern parallels `resetInFlight` × `deliberationInFlight` mutual exclusion already present in v0.5.1.

Set BEFORE provider.chat call (parallel to `session-reset.ts:100` setting `resetInFlight` before LLM).

**Empty segment guard**:

If `currentSegment.messages.length === 0` (e.g. immediately after a reset), `/councildone` rejects with 「本 segment 尚無討論，請先進行議論」. Pattern parallels `session-reset.ts:70`.

## 8. Synthesis pipeline

```ts
async synthesize(threadId: number, preset: Preset): Promise<ArtifactRow> {
  // === Phase 1: pre-checks (no mutation) ===
  //
  // Missing-config check FIRST — §10 promises a lazy user-facing rejection
  // when no agent declares `role_type: artifact-synthesizer`. This branch
  // makes that promise authoritative; without it, `this.synthesizerConfig`
  // would be null and the later `createProvider(this.synthesizerConfig.provider)`
  // dereference (Phase 2) would surface a TypeError instead of the documented
  // 「`/councildone` 需要 `artifact-synthesizer` worker…」 message.
  if (this.synthesizerConfig === null) {
    throw new MissingSynthesizerConfigError();   // adapter renders §10 message
  }
  //
  // ORDER MATTERS: guards run BEFORE the cached fast-path. A user can send a
  // new message and immediately type `/councildone` before the gateway router
  // has finished classifying that message — `pendingClassifications` will be
  // set but the new turn is NOT yet appended to `currentSegment.messages`.
  // If the fast-path ran first, `currentSegment.messages.length === 0` would
  // be (still) true and the cached artifact would be returned, silently
  // dropping the user's new message from synthesis.
  //
  // The cost of moving guards in front of the cache is negligible: every
  // guard is an in-memory boolean / set check on the handler. The cached
  // return is no longer "0-cost early exit", but `/councildone` is a
  // user-typed command, not a hot loop, so the difference is invisible.

  // Bidirectional locks (transient)
  if (handler.isResetInFlight(threadId)) throw ResetInFlightError;
  if (handler.isDeliberationInFlight(threadId)) throw DeliberationInFlightError;
  if (handler.hasPendingClassifications(threadId)) throw PendingClassificationError;
  // Persistent guard
  if (handler.getBlindReviewSessionId(threadId)) throw BlindReviewActiveError;

  // After all guards pass: read currentSegment and consider fast-path.
  const currentSegment = handler.getCurrentSegment(threadId);

  // Fast-path: return cached row only if ALL of:
  //   1. a previous /councildone for this thread + preset exists, AND
  //   2. the cached artifact's segment_index equals the latest sealed
  //      segment_index across BOTH reset snapshots and artifacts (so
  //      a /councilreset between the cached artifact and now invalidates
  //      the cache, because reset advances the cross-table max), AND
  //   3. the current (open) segment is still empty (no user messages
  //      added since the seal — handles the post-/councildone idempotent
  //      retry case where the cached artifact IS the latest sealed segment).
  //
  // Guards above already ensured pendingClassifications is empty, so
  // condition 3's `messages.length === 0` is now an authoritative
  // "no user content has arrived" signal, not a "no content yet visible"
  // signal.
  const cached = artifactDb.findByThreadPreset(threadId, preset);
  const lastSealedIdx = this.lastSealedSegmentIndex(threadId);  // see §4
  if (
    cached &&
    lastSealedIdx !== null &&
    cached.segment_index === lastSealedIdx &&
    currentSegment.messages.length === 0
  ) {
    return cached;
  }

  // Live segment requirement (reuse currentSegment from above)
  if (currentSegment.messages.length === 0) throw EmptySegmentError;

  if (handler.isSynthesisInFlight(threadId)) throw SynthesisAlreadyRunning;

  // === Phase 2: synthesis (no segment mutation) ===
  handler.setSynthesisInFlight(threadId, true);
  let response: ProviderResponse;
  try {
    // ArtifactService is constructed with the synthesizer's AgentConfig
    // (extracted from the worker pool at wire time in src/index.ts; see §12).
    // We use the AgentConfig — not AgentWorker — because AgentWorker.config
    // is private. The actual factory exports `createProvider(name: string)`
    // (src/worker/providers/factory.ts:7), keyed on the provider NAME, not
    // on the config object. Model is read from the same AgentConfig.
    const provider = createProvider(this.synthesizerConfig.provider);
    const { messages, options } = buildArtifactPrompt(
      preset,
      currentSegment.messages,
      this.synthesizerConfig.model,
    );

    response = await invokeWithRetry(provider, messages, options);

    const parsed = parseArtifact(response.content);
    if (!parsed.tldr) throw new MalformedArtifactError(response.content);

    // === Phase 3: commit ===
    // Compute segment_index using the SAME formula as session-reset.ts:172.
    // For the v0.5.1 reset path the formula is:
    //   existing.length > 0 ? max(existing.map(s => s.segmentIndex)) + 1
    //                       : handler.getSegments(threadId).length - 1
    // We extend "existing" to mean "segments already sealed for this thread",
    // pulling from BOTH session_reset_snapshots AND council_artifacts so the
    // counter is monotonic regardless of which command sealed the segment.
    const sealedIndices = [
      ...resetDb.listSnapshotsForThread(threadId).map(s => s.segmentIndex),
      ...artifactDb.findByThread(threadId).map(a => a.segment_index),
    ];
    const newSegmentIndex = sealedIndices.length > 0
      ? Math.max(...sealedIndices) + 1
      : handler.getSegments(threadId).length - 1;

    const newSeq = (artifactDb.maxThreadLocalSeq(threadId) ?? 0) + 1;

    // In-memory seal happens FIRST so we can roll it back if the DB insert
    // throws. SQLite transactions cannot undo in-memory mutations.
    handler.sealCurrentSegment(threadId, /* snapshotId */ null);
    let inserted: ArtifactRow;
    try {
      inserted = artifactDb.insert({
        thread_id: threadId,
        segment_index: newSegmentIndex,
        thread_local_seq: newSeq,
        preset,
        content_md: response.content,
        created_at: new Date().toISOString(),
        synthesis_model: response.modelUsed ?? options.model,
        synthesis_token_usage_json: JSON.stringify(response.tokensUsed),
      });
    } catch (insertErr) {
      // Manual in-memory rollback (parallel to session-reset.ts:190 pattern)
      handler.unsealCurrentSegment(threadId);  // see §12 modified files
      throw insertErr;
    }

    // openNewSegment is also fallible (handler may throw on internal
    // invariant breach, e.g. inconsistent in-memory state). If it fails
    // AFTER artifact insert succeeded, we must attempt to roll BOTH back:
    // the DB row (delete by id) and the in-memory seal (unseal). Otherwise
    // the thread is stranded with sealed currentSegment + no live segment
    // to append to, and a "successfully inserted" artifact that the user
    // can't reach until manual recovery.
    //
    // BEST-EFFORT: each rollback step is wrapped so that a failing
    // deleteById doesn't skip the unseal (and vice versa). If either
    // cleanup throws, we log it (visible to operator via stderr) and
    // re-throw the ORIGINAL openErr — that is the lifecycle error the
    // user/operator needs to debug, not the secondary cleanup failure.
    // Mirrors `SessionReset.reset` rollback discipline.
    try {
      handler.openNewSegment(threadId);
    } catch (openErr) {
      try {
        artifactDb.deleteById(inserted.id);          // see §4 helpers
      } catch (delErr) {
        console.error(
          '[ArtifactService] rollback: deleteById failed after openNewSegment failure',
          delErr,
        );
      }
      try {
        handler.unsealCurrentSegment(threadId);
      } catch (unsealErr) {
        console.error(
          '[ArtifactService] rollback: unsealCurrentSegment failed after openNewSegment failure',
          unsealErr,
        );
      }
      throw openErr;
    }

    eventBus.emit('artifact.created', {
      threadId,
      segmentIndex: newSegmentIndex,
      threadLocalSeq: newSeq,
      preset,
    });
    return inserted;
  } finally {
    handler.setSynthesisInFlight(threadId, false);
  }
}
```

If `invokeWithRetry` exhausts retries OR throws `MalformedArtifactError`: we never reach Phase 3, segment stays unsealed, no row inserted, lock released by `finally`. User can retry `/councildone` immediately.

If the DB INSERT throws (UNIQUE violation, disk full, etc.): `unsealCurrentSegment` reverts the in-memory seal so the segment remains live. User retries.

**`sealCurrentSegment` / `unsealCurrentSegment` extension**: existing `sealCurrentSegment(threadId, snapshotId)` (`src/council/deliberation.ts:306`) takes a non-null `snapshotId` for reset path. Modify signature to `sealCurrentSegment(threadId, snapshotId: string | null)`. Persisted in-memory segment gets the null id verbatim; downstream consumers (`/councilhistory`) treat null as "sealed by `/councildone`" rather than `/councilreset`. Add new `unsealCurrentSegment(threadId)` that reverts the most recent seal IFF that segment was sealed in this process (no DB rollback — only used inside the artifact rollback path before any state escapes the synthesize call).

**`invokeWithRetry` policy**:

```ts
const PER_ATTEMPT_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 4;
const SLEEPS_MS = [1000, 2000, 4000];  // sleep BEFORE attempts 2, 3, 4

// Provider-side empty-response sentinels.
//
// Some providers (notably OpenAI in v0.5.1, src/worker/providers/openai.ts:34)
// rewrite empty completions into a non-empty diagnostic string before
// returning, e.g. `（gpt-5 未回傳內容，finish_reason: length）`. That
// rewrite is intentional for chat surfaces (avoids printing a blank
// agent turn) but defeats the artifact retry path: `response.content`
// is non-empty so the `length === 0` branch never fires, the sentinel
// reaches `parseArtifact`, the `## TL;DR` regex misses, and we hard
// fail with `MalformedArtifactError` after exactly 1 attempt — silently
// converting a transient empty completion into a one-shot user-visible
// failure.
//
// Detect the OpenAI sentinel explicitly and treat it as
// EmptyResponseError so the normal retry policy applies. Pattern is
// anchored to the wrapper text the provider injects, not the model
// name (which varies per call).
const OPENAI_EMPTY_SENTINEL = /^（[^（）]+未回傳內容，finish_reason:\s*[^）]+）\s*$/;

function isProviderEmptyResponse(content: string): boolean {
  if (!content || content.trim().length === 0) return true;
  if (OPENAI_EMPTY_SENTINEL.test(content.trim())) return true;
  return false;
}

async function invokeWithRetry(
  provider: LLMProvider,
  messages: ProviderMessage[],
  options: ChatOptions,
): Promise<ProviderResponse> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(SLEEPS_MS[attempt - 2]);
    try {
      const response = await invokeProviderForArtifact(
        provider, messages, options, PER_ATTEMPT_TIMEOUT_MS
      );
      // Empty content (literal) OR provider-rewritten sentinel = transient
      if (isProviderEmptyResponse(response.content)) {
        lastErr = new EmptyResponseError();
        continue;
      }
      return response;
    } catch (err) {
      lastErr = err;
      if (isHardFail(err)) throw err;
      // else: loop iterates, sleeps, retries
    }
  }
  throw new SynthesisRetryExhaustedError(lastErr);
}

function isHardFail(err: unknown): boolean {
  if (err instanceof ProviderTimeoutError) return false;     // caller timeout, retry
  if (err instanceof EmptyResponseError) return false;       // retry
  if (err instanceof Error && 'status' in err) {
    const status = (err as { status: number }).status;
    if (status === 429) return false;                        // rate limit, retry
    if (status >= 500 && status < 600) return false;         // server error, retry
    if (status >= 400 && status < 500) return true;          // 401/403/404/400, hard
  }
  // No `.status` (network failure, fetch reject, parse error, etc.)
  // Retry conservatively — better to waste retries than reject transient errors.
  return false;
}
```

This depends on the one-line `CustomProvider` fix in §5 (attach `.status` to thrown error). Without that fix, all CustomProvider errors hit the "no `.status`" path and retry conservatively — still works, but distinguishes transient vs permanent loses precision.

**Total worst case** with all retries: 30s × 4 attempts + (1s + 2s + 4s) sleeps = ~127 seconds. Typical single-attempt synthesis is < 15s; retry storm means the provider is genuinely down and user gets a clear error after the bound.

## 9. User surface

`/councildone [preset]` response (after success):

```
✅ Artifact #3 (decision) created.

TL;DR: <first 200 chars of TL;DR section>...

完整內容: /councilshow 3
```

`/councilshow <id>` response: full `content_md`, chunked at 4096 chars on Telegram, single message on CLI.

```ts
// src/util/chunk-markdown.ts (new)
export function chunkMarkdown(text: string, maxChars: number): string[];
```

Chunking is character-boundary (plain text mode). MarkdownV2 escape semantics deferred (Telegram surface uses plain text, not MarkdownV2 parse mode). Algorithm:

1. If `text.length <= maxChars`: return `[text]` (single chunk).
2. Otherwise, find the last `\n\n` (paragraph boundary) at or before `maxChars`. If found: split there, recurse on remainder.
3. Otherwise, find the last whitespace at or before `maxChars`. If found: split there, recurse on remainder.
4. Otherwise (single token longer than `maxChars`): **hard split mid-token at exactly `maxChars`**, recurse on remainder.

Step 4 means the function never returns a chunk larger than `maxChars`. A 5000-char single token with `maxChars=4096` returns `[<4096 chars>, <904 chars>]`. This guarantees Telegram's 4096 limit is never violated regardless of artifact content. Mid-token splits can produce visually awkward chunks but the alternative is silent message-send failure.

Empty input returns `[]` (not `['']`) — caller iterates `chunks.forEach(send)` and gets a no-op. Reused by future `/councilhistory`.

## 10. Missing-config behavior

If no file in `config/agents/*.yaml` declares a worker with `role_type: artifact-synthesizer` (note: YAML key is snake_case `role_type`; the TypeScript field is `roleType`):

- Startup proceeds normally. Other commands (`/council`, `/blindreview`, etc.) work.
- `ArtifactService` is constructed with `synthesizerConfig = null` (see §12 `src/index.ts`).
- `/councildone` rejects via `MissingSynthesizerConfigError` thrown from the very first check in `ArtifactService.synthesize` (see §8 Phase 1). The adapter (CLI / Telegram) catches that error class and renders: 「`/councildone` 需要 `artifact-synthesizer` worker，請新增一個 `config/agents/<name>.yaml` 並設 `role_type: artifact-synthesizer`，重啟後生效。範例見 `docs/synthesizer-config.md`」.
- `/councilshow` works without synthesizer config (read-only on existing rows from earlier successful synthesis).

This contract is what makes the Phase-1 null guard in §8 the sole source of truth for missing-config behavior — no other call site dereferences `synthesizerConfig` before that check.

## 11. Test invariants

12 explicit invariant suites (1-12) plus suites 5a (cache invalidation on new messages), 5b (cache invalidation on reset), and 7a (malformed output) plus two appended cross-cutting tests (DB migration; `/councilshow` thread-scoping). Counts informational, not contractual.

1. **Command routing** — `/councildone` and `/councilshow` (with leading slash) are intercepted in CLI + Telegram BEFORE the catch-all message handler and BEFORE `GatewayRouter`'s end-keyword classification. Unknown slash commands not eaten by these handlers. **Out of scope for v0.5.2.a**: `GatewayRouter`'s existing substring match on `done` (and other end keywords from `src/config.ts:69`) for plain text messages remains unchanged. v0.5.2.a only requires that the slash-prefixed `/councildone` form bypasses the router; it does NOT propose changing the router's plain-text keyword matching.

2. **Modal capture** — N/A in v0.5.2.a (no negotiation flow).

3. **In-flight guards (transient)** — `/councildone` issued during `deliberationInFlight` returns wait message; same for `pendingClassifications` and `resetInFlight`. After flag clears, retry succeeds.

4. **In-flight guards (persistent)** — `/councildone` issued during `blindReviewPending` returns reject-with-instruction immediately, does NOT wait, does NOT call synthesizer.

5. **Idempotent done (cached lookup)** — first `/councildone universal` succeeds and seals segment N (opens empty segment N+1). Without sending any new message, second `/councildone universal` triggers fast-path: lookup finds artifact for segment N + preset universal, the open segment N+1 is empty, returns cached row, makes ZERO LLM calls, leaves DB row count unchanged. Asserts: provider mock invocation count remains 1 across both calls. Different preset (`/councildone decision` after `universal`) on the same already-sealed segment also takes the empty-segment path: there is no live segment to synthesize against (segment N is sealed, segment N+1 is empty), so it returns `EmptySegmentError` ("本 segment 尚無討論"). To get a `decision` artifact, user must add at least one message in the new segment.

   **5a. Cache invalidation on new discussion** — first `/councildone universal` succeeds (seals N, opens empty N+1). User sends one message in segment N+1. Second `/councildone universal`: fast-path is skipped (`currentSegment.messages.length > 0`), full synthesis runs, new artifact for segment N+1 is INSERTed, provider mock invocation count is 2. Asserts cache check was bypassed even though `cached.segment_index === lastSealedSegmentIndex` (the open-segment-empty guard is what disqualifies the cache). Failure mode: returning the segment-N artifact when user has already added new content.

   **5b. Cache invalidation on reset between done calls** — first `/councildone universal` succeeds (seals N, opens empty N+1). User adds at least one message in segment N+1 (required because `SessionReset.reset` rejects empty segments via `EmptySegmentError` at `session-reset.ts:70`). User runs `/councilreset`, which seals N+1 into `session_reset_snapshots` and opens empty N+2. User runs `/councildone universal` again. Fast-path is skipped because `lastSealedSegmentIndex` now returns N+1 (from the reset snapshot) which ≠ `cached.segment_index = N`. Empty-segment guard then fires on N+2 (`currentSegment.messages.length === 0`), command rejects with `EmptySegmentError` ("本 segment 尚無討論"). After user adds a message in segment N+2 and retries, full synthesis runs and produces a NEW artifact for segment N+2. Failure mode: returning the segment-N artifact post-reset, leaking pre-reset content into a fresh discussion.

6. **Synthesis lock** — concurrent `/councildone` invocations on the same thread WHILE first is mid-LLM: first holds `synthesisInFlight`, second receives `SynthesisAlreadyRunning` error. Lock releases on both success and failure paths (verified via `finally` block test: throw inside synth → assert lock cleared).

7. **Synthesizer failure + retry** — mock provider scenarios:
   - Returns transient 5xx twice then success → artifact created on attempt 3, total 3 invocations
   - Returns 429 once then success → retried (429 not hard-fail), artifact created on attempt 2
   - Returns 401 → hard fail immediately, 1 invocation, no artifact, segment NOT sealed
   - Returns 404 → hard fail immediately
   - Throws plain `new Error('boom')` (no `.status`) on every attempt → `isHardFail` returns false ("retry conservatively" — see §8), retried up to `MAX_ATTEMPTS = 4`, then `SynthesisRetryExhaustedError` is thrown wrapping the last error. Total 4 invocations. Segment NOT sealed, no row inserted.
   - Throws `AbortError` (timeout fired) on attempt 1, succeeds on attempt 2 → retried
   - Hangs forever on every attempt → 4 attempts each timing out at 30s, total ~127s wall clock, then `SynthesisRetryExhaustedError`
   - **Provider returns OpenAI-style empty sentinel** `（model 未回傳內容，finish_reason: length）` on attempt 1, valid TL;DR-bearing markdown on attempt 2 → `isProviderEmptyResponse` matches the sentinel, `EmptyResponseError` recorded, retried, success on attempt 2. Total 2 invocations. Verifies the sentinel detection prevents one-shot `MalformedArtifactError` when an upstream provider rewrites empty completions into diagnostic text. Failure mode: sentinel reaches `parseArtifact`, hard fails after 1 invocation.
   - All retry-exhausted paths leave segment unsealed, no row inserted, `synthesisInFlight` cleared

7a. **Synthesizer malformed output** — mock provider returns text without `## TL;DR` heading on attempt 1: NOT retried (malformed = prompt-level bug, not transient), `MalformedArtifactError` thrown, segment NOT sealed, no row inserted.

8. **Artifact scope invariant** — assert that `ArtifactService.synthesize` reads ONLY the current segment's messages, not pre-reset content. Concretely: spy `handler.getCurrentSegment` and pass through; assert `buildArtifactPrompt` is called with `currentSegment.messages` exactly equal to the 3 messages added after the most recent reset. Do NOT assert against `content_md` token contents — `/councilreset` legitimately prepends prior summaries via `snapshotPrefix` into the new-segment worker context (deliberation-side carry-forward, see `session-reset.ts` snapshot logic), so worker outputs and downstream artifact text MAY echo pre-reset decisions. The contract being tested is "synthesizer's input transcript = current segment only", not "synthesizer's output never references prior segments". Failure mode: synthesizer is fed snapshot-prefixed messages or full transcript history.

9. **Chunking helper unit** — algorithm from §9:
   - Empty string returns `[]` (not `['']`)
   - 4096-char string returns single chunk of 4096 chars
   - 4097-char string returns 2 chunks (paragraph boundary preferred, else word boundary, else hard cut)
   - Single 5000-char token (no whitespace, no `\n\n`) returns 2 chunks: `[<exactly 4096 chars>, <904 chars>]` — hard split mid-token at maxChars
   - Multi-paragraph input (e.g. 3000-char paragraph + 2000-char paragraph) splits at `\n\n` boundary into `[3000-char, 2000-char]` chunks
   - Every returned chunk satisfies `chunk.length <= maxChars` invariant (no chunk ever exceeds limit)

10. **Synthesizer worker isolation** — three sub-tests with distinct failure modes:

    10a. **Pool composition**: configure 3 workers with `roleType: 'peer'`, 1 with `roleType: 'facilitator'`, 1 with `roleType: 'artifact-synthesizer'`. Assert `peerWorkers.length === 3`, `peerWorkers` does NOT contain worker with `roleType === 'artifact-synthesizer'` AND does NOT contain the facilitator. Failure mode: `peerWorkers` includes the artifact-synthesizer.

    10b. **Round-role assignment is independent of worker pool**: with same config as 10a, run a deliberation round where the role-assigner gives one peer worker the `AgentRole.synthesizer` round role (the existing peer-assignable role, not to be confused with `roleType`). Assert that peer DOES get invoked by `runDeliberation` for that round (proving `assignedRole='synthesizer'` is unrelated to `peerWorkers` filtering). Failure mode: peer with synthesizer round-role is dropped from deliberation.

    10c. **ArtifactService is sole invoker of artifact-synthesizer worker**: instrument the `provider.chat()` call site on the `artifact-synthesizer` worker's provider with a counter. Run a full council deliberation (multiple rounds) without `/councildone`: counter remains 0. Then call `ArtifactService.synthesize()` once: counter becomes 1. Failure mode: `runDeliberation` invokes the artifact-synthesizer's provider, OR `ArtifactService.synthesize` fails to invoke it.

11. **Bidirectional in-flight mutual exclusion**:

    11a. **`/councildone` blocks `/councilreset`**: start `ArtifactService.synthesize` (mock provider hangs to keep `synthesisInFlight` set). Concurrently invoke `SessionReset.reset` on the same thread: rejects with persistent-style message 「synthesis 進行中，請稍候再下 `/councilreset`」 (no LLM call). Release synthesis lock; reset retry succeeds.

    11b. **`/councildone` blocks new agent rounds**: same setup; concurrently send a regular user message that would trigger `runDeliberation`. New round rejects with transient "please wait" message.

    11c. **`/councildone` blocked by reset/deliberation/blind-review**: with `resetInFlight` true → SynthesizeService throws `ResetInFlightError`. With `deliberationInFlight` true → throws `DeliberationInFlightError`. With `blindReviewSessionId` non-null → throws `BlindReviewActiveError` (persistent guard). Each separately tested.

12. **`artifact.created` listener convention**: scan all listeners registered for `'artifact.created'` in this feature's source files. Each must be a pure read-side function (logging, metrics emission). No listener calls `handler.sealCurrentSegment`, `artifactDb.insert`, etc. Failure mode: a future contributor adds a mutating listener and reopens the v0.5.2 P1-B race. (Test asserts via static analysis: grep for `'artifact.created'` listener bodies, fail if any reference mutating APIs.)

Plus DB migration test: fresh db creates `council_artifacts` table; existing v0.5.1 db migrates without losing rows in other tables.

Plus `/councilshow` thread-scoping test: artifact id 3 in thread A; user in thread B issues `/councilshow 3`; receives "artifact not found" (NOT thread A's artifact, NOT existence-leak).

## 12. Files touched

New:

- `src/council/artifact-service.ts` — `ArtifactService` (synthesize, fetchByThreadLocalSeq)
- `src/council/artifact-db.ts` — sqlite layer for `council_artifacts`
- `src/council/artifact-prompt.ts` — preset-specific prompt builder (bypasses personality.ts)
- `src/util/chunk-markdown.ts` — shared chunking helper
- `src/cli/commands/council-done.ts`, `src/cli/commands/council-show.ts`
- `src/telegram/commands/council-done.ts`, `src/telegram/commands/council-show.ts`
- `tests/council/artifact-service.test.ts`
- `tests/council/artifact-db.test.ts`
- `tests/util/chunk-markdown.test.ts`
- `tests/integration/council-done-flow.test.ts`
- `tests/integration/council-done-guards.test.ts`
- `docs/synthesizer-config.md`

Modified:

- `src/types.ts` — introduce named `WorkerRoleType` alias, extend with `'artifact-synthesizer'`, update `AgentConfig.roleType` to use the alias
- `src/index.ts` — three changes:
    1. `peerWorkers` filter excludes `artifact-synthesizer` (using `effectiveRoleType` helper from §5 to handle optional `roleType`).
    2. Locate the synthesizer worker's `AgentConfig` via `agents.find(a => effectiveRoleType(a) === 'artifact-synthesizer')` and pass it to the new `ArtifactService` constructor (lazy: if undefined, `ArtifactService` stores null and the missing-config rejection in §10 fires at command time).
    3. **Update startup peer-config selection (two call sites) to skip artifact-synthesizer configs.** Two places in v0.5.1 currently default to `agentConfigs[0]` and would silently bind to a synthesizer config if it sits first in `config/agents/`:
        - `getOrCreateProvider(agentConfigs[0].provider)` at `src/index.ts:154` — seeds the `IntentGate` mainProvider.
        - `councilConfig.participation?.listenerAgent || agentConfigs[0].id` at `src/index.ts:130` — picks the Telegram listener agent fallback when `participation.listenerAgent` is omitted from `council.config.yaml`.
       Define one helper `pickFirstPeerConfig(agents) = agents.find(a => effectiveRoleType(a) === 'peer') ?? agents[0]` and use it at BOTH sites:
        - mainProvider: `getOrCreateProvider(pickFirstPeerConfig(agentConfigs).provider)`
        - listenerAgent: `councilConfig.participation?.listenerAgent || pickFirstPeerConfig(agentConfigs).id`
       This preserves the §10 lazy-provider contract (synthesizer is only constructed when `/councildone` actually runs) and keeps the Telegram listener bound to a peer agent that has a real bot token — synthesizer configs typically have no `botTokenEnv`, so binding the listener to one breaks Telegram setup before `/councildone` is even usable. The `?? agents[0]` fallback covers degenerate configs (no peer at all) and preserves current behavior in pure-peer setups.
- `src/adapters/cli-commands.ts` — whitelist `councildone`, `councilshow`
- `src/adapters/cli-dispatch.ts` — route both commands
- `src/adapters/telegram.ts` — add wiring methods `wireCouncilDone(handler)` + `wireCouncilShow(handler)` parallel to existing reset/blind/PVG/critique wiring
- `src/telegram/bot.ts` — register both `bot.command(...)` BEFORE catch-all message handler, via the new adapter wiring methods
- `src/council/deliberation.ts` — add `synthesisInFlight: Set<number>` private field (per-thread) plus public `setSynthesisInFlight(threadId, value: boolean)` / `isSynthesisInFlight(threadId): boolean` accessors so `ArtifactService` and `SessionReset` can read/write through the handler; extend `sealCurrentSegment(threadId, snapshotId: string | null)` to accept null; add `unsealCurrentSegment(threadId)` for in-memory rollback path; add `runDeliberation` guard against `isSynthesisInFlight(threadId)` (parallel to existing `resetInFlight` guard); expose `getCurrentSegment(threadId)`, `isResetInFlight(threadId)`, `isDeliberationInFlight(threadId)`, `hasPendingClassifications(threadId)`, `getBlindReviewSessionId(threadId)` query helpers if not already public
- `src/council/session-reset.ts` — two changes:
    1. Add `handler.isSynthesisInFlight(threadId)` guard (parallel to its existing in-flight checks); reject with 「synthesis 進行中，請稍候再下 `/councilreset`」.
    2. **Replace single-table segment-index lookup at `:172` with the cross-table union formula in §4** (`max(session_reset_snapshots ∪ council_artifacts) + 1`, fresh-thread fallback unchanged). Without this, the post-restart, post-artifact, pre-reset path duplicates `segment_index`, which corrupts cache invalidation (`lastSealedSegmentIndex` would tie to an old artifact) and the `(thread_id, segment_index)` lookup contract.
- `src/events/bus.ts` — extend `EventMap` with `'artifact.created'` event payload type
- `src/worker/providers/custom.ts` — one-line fix: attach `.status` to thrown error so `isHardFail` can classify CustomProvider 429/5xx correctly
- `CHANGELOG.md` — v0.5.2.a entry
- `package.json` — version bump to 0.5.2

## 13. Migration

Additive only. Existing v0.5.1 databases get a `CREATE TABLE IF NOT EXISTS council_artifacts ...` migration in `data/council.db`. No rows in other tables are touched.

**v0.5.1 tables, by database** (verified via `rg "CREATE TABLE" src/` and `rg "brain\.db|council\.db" src/`):

`data/brain.db` (memory schema, owned by `src/memory/db.ts`):
- `memories`
- `patterns`

`data/council.db` (council runtime, owned by `src/storage/reset-snapshot-db.ts`, `src/council/blind-review-db.ts`, `src/council/pvg-rotate-db.ts`, and **new** `src/council/artifact-db.ts`):
- `blind_review_events`
- `blind_review_sessions`
- `blind_review_stats`
- `pvg_rotate_rounds`
- `session_reset_snapshots`
- `council_artifacts` (NEW)

(Note: there is NO `session_summaries` table in v0.5.1 — session summaries are markdown files written via `src/memory/session-summary.ts`. An earlier draft of this spec mistakenly listed `session_summaries`.)

**Migration test scope** — split by database to avoid the v0.5.1 table list collapsing into one assertion against the wrong file:

- *council.db migration test*: opens an existing v0.5.1 council.db, asserts pre-migration row counts in `blind_review_events`, `blind_review_sessions`, `blind_review_stats`, `pvg_rotate_rounds`, `session_reset_snapshots` are unchanged after migration; asserts `council_artifacts` table exists and has 0 rows post-migration.
- *brain.db non-impact test*: opens an existing v0.5.1 brain.db, asserts the `memories` and `patterns` row counts are unchanged after the council migration runs (i.e. the artifact migration does NOT touch brain.db, no accidental table creation in the wrong file).

**Worker-role union extension safety**: extending `WorkerRoleType` from `'peer' | 'facilitator'` to add `'artifact-synthesizer'` is strictly additive. Existing `config/agents/*.yaml` files set `role_type` to `'peer'` or `'facilitator'` (or omit the field, which defaults to `'peer'`); none use `'artifact-synthesizer'` (a brand-new value). Loading existing configs after this change cannot fail because the union now permits a strict superset of values.

## 14. Codex finding map

This design closes the following findings from `.codex-review-2026-04-25-v052a-artifact.md`:

| Finding | Resolution | Section |
|---|---|---|
| P1-1 (boundary stability) | seal segment on `/councildone` | §3, §8 |
| P1-2 (synthesis lock) | `synthesisInFlight` flag set before LLM call | §7, §8 |
| P1-3 (UNIQUE constraint) | `UNIQUE(thread_id, segment_index)` | §4 |
| P1-4 (segment-index restart-safe) | DB-derived counter (parallel to reset) | §8 |
| P1-5 (worker isolation) | `peerWorkers` filter explicit | §5, §11 (suite 10) |
| P1-6 (naming collision) | `artifact-synthesizer` (hyphenated) | §5 |
| P1-7 (no listener path) | `ArtifactService.synthesize` directly awaited | §3, §8 |
| P1-8 (cross-thread leak) | thread-local seq + `WHERE thread_id=?` | §4, §6, §11 |
| P1-9 (command routing) | both commands whitelisted before catch-all | §6 |
| P1-10 (guard taxonomy) | transient/persistent split | §7 |
| P1-11 (empty segment) | early reject | §7 |
| P1-12 (markdown ban bypass) | dedicated prompt builder | §5 |
| P1-13 (retry error matrix) | `isHardFail` + per-attempt timeout | §8 |
| P2-1 (TL;DR extraction) | mandatory `## TL;DR` heading | §5 |
| P2-2 (chunk parse mode) | plain text Telegram surface | §9 |
| P2-3 (missing config) | lazy reject, opt-in upgrade | §10 |
| P2-4 (timestamp style) | ISO 8601 TEXT | §4 |

## 15. Decisions log

19 decisions made across two brainstorming passes:

**Pass 1 — original 11 v0.5.2.a decisions**:

| # | Topic | Decision |
|---|---|---|
| Q-pre | Scope split | a (artifact) + b (contract, deferred) |
| Meta | Continue this session | Restart brainstorming for v0.5.2.a |
| Q1.a | Trigger | `/councildone` only |
| Q2.a | Synthesizer ownership | new first-class `artifact-synthesizer` worker |
| Q3.a | Template selection | `/councildone <preset>` user-explicit |
| Q3.a-fu | Preset count | 2: `universal` (default) + `decision` |
| Q4.a | Concurrency | wait for in-flight + pending |
| Q5.a | Storage | new `council_artifacts` table, append-only |
| Q6.a | Reset boundary | current segment only |
| Q7.a | User surface | inline summary + `/councilshow <id>` |
| Q7.a-fu | Chunking | shared `chunkMarkdown` helper, in v0.5.2.a |
| Q8.a | Failure | MAX_ATTEMPTS=4 with sleeps 1s/2s/4s before attempts 2/3/4; SynthesisRetryExhaustedError thereafter (4xx hard fails immediately) — see §8 for full matrix |
| Q9.a | Forward-compat hooks | none |
| Q10.a | Idempotent done | cached artifact returned |

**Pass 2 — Codex finding closure (8 decisions)**:

| # | Topic | Decision |
|---|---|---|
| Q11.a | Cache key | seal segment on done |
| Q12.a | UNIQUE constraint | `(thread_id, segment_index)` |
| Q13.a | Worker naming | `artifact-synthesizer` (hyphenated) |
| Q14.a | Artifact id | thread-local sequence |
| Q15.a | Guard taxonomy | transient (wait) vs persistent (reject) |
| Q16.a | Retry matrix | unified backoff, `isHardFail` matrix, 30s timeout |
| Q17.a | Missing config | lazy reject |
| Q18.a | Implementation invariants | accept P1-7 + P1-12 as design constraints |

## 16. Exit criteria

- All 12 invariant test suites green plus suites 5a (cache invalidation on new messages), 5b (cache invalidation on reset), and 7a (malformed output) plus migration test plus `/councilshow` thread-scoping test.
- `/councildone` produces TL;DR-bearing markdown for both presets in CLI + Telegram surfaces.
- `/councilshow` returns chunked content (Telegram) / full content (CLI).
- `npm ci && tsc --noEmit && npm test && npm run build` green locally before push.
- Codex re-review (`/codex review` against the implementation diff) returns 0 P1.

## 17. Spec-review resolution log (round 3, 2026-04-25)

The Codex spec-level review (`.codex-review-2026-04-25-v052a-design-doc.md`, 15 P1 + 2 P2) found contradictions between spec sections, claims-of-closure that didn't hold up against the codebase, and underspecified parsing rules. All findings closed inline by the rewrite. Map:

| Finding | Resolution | Sections changed |
|---|---|---|
| P1-1 (idempotency vs seal contradiction) | Fast-path cached lookup BEFORE acquiring lock; seal+open inside transaction AFTER successful synthesis | §3, §8, §11 invariant 5 |
| P1-2 (no rollback on synthesis failure) | Seal moved INSIDE transaction, AFTER LLM success; failure leaves segment unsealed | §3, §8 |
| P1-3 (segment_id source mismatch) | Renamed `segment_id` → `segment_index`; share counter with `session_reset_snapshots.segment_index` via `max(both, in-memory)+1` | §4, §8 |
| P1-4 (markdown ban bypass not implementable) | **[REGRESSED IN ROUND 4 — see §18]** Round-3 attempt: New `invokeProviderForArtifact` calls `provider.invoke()` directly, skipping `AgentWorker.respond` entirely. Round-3 was wrong: `LLMProvider` has no `.invoke()` method. Round-4 closure uses real `provider.chat(messages, options)` API; current correct spec is in §5. | §5, §8 |
| P1-5 (`{timeout: 30_000}` fictional API) | **[REGRESSED IN ROUND 4 — see §18]** Round-3 attempt: Caller-side `AbortController` + `setTimeout(..., 30_000)`, no `ChatOptions` change. Round-3 was wrong: providers do not accept `AbortSignal`. Round-4 closure uses caller-side `Promise.race(provider.chat, setTimeout)` with `ProviderTimeoutError` and `clearTimeout` in `finally`; current correct spec is in §5. | §8 |
| P1-6 (retry matrix inconsistent) | Rewrote: 4 attempts, 3 sleeps `[1s, 2s, 4s]` BEFORE attempts 2-4; 429 retried; CustomProvider-style `Error` (no `.status`) hard-failed (later refined in round 7 to retry conservatively for no-`.status` cases — see §8 `isHardFail`) | §8 |
| P1-7 (malformed TL;DR self-contradiction) | Hard fail without retry on missing TL;DR; new test invariant 7a | §5, §8, §11 (added 7a) |
| P1-8 (`/councildone universal` self-rejected) | Parser explicitly accepts both `universal` and `decision`; empty defaults to `universal` | §6 |
| P1-9 (`/councilshow` underspecified) | Regex `^[1-9]\d{0,9}$`, extra args reject | §6 |
| P1-10 (chunking 5000-char overflow) | Hard split mid-token at exactly `maxChars`; explicit 4-step algorithm | §9 |
| P1-11 (router `done` keyword scope) | Reduced scope: only `/councildone` (slash form) bypass router; plain-text `done` unchanged | §11 invariant 1 |
| P1-12 (adapter wiring missing) | Added `src/adapters/telegram.ts` to modified files with new wire methods | §12 |
| P1-13 (EventMap not extended) | Added `src/events/bus.ts` to modified files; `'artifact.created'` payload typed in §4 | §4, §12 |
| P1-14 (worker isolation test imprecise) | Split into 3 sub-tests (10a/10b/10c) with distinct failure modes | §11 |
| P1-15 (migration table list wrong) | Listed authoritative 7 v0.5.1 tables, removed `session_summaries`, added blind-review tables | §13 |
| P2-1 (`WorkerRoleType` not a named type) | §5 explicitly introduces the alias and updates `AgentConfig.roleType` to use it | §5 |
| P2-2 (config path/key wrong) | Corrected to `config/agents/*.yaml` directory + `role_type` snake_case YAML key | §10 |

## 18. Spec-review resolution log (round 4, 2026-04-25)

Round 4 (`.codex-review-2026-04-25-v052a-design-doc-r4.md`, 7 P1 + 3 P2) found 6 round-3 fixes regressed during the rewrite. Root cause for most: I wrote the spec rewrite without re-reading the actual provider interface. The Q-fix-1 + Q-fix-2 brainstorm pass (after round 4) rebuilt the invocation API on verified ground truth before the second rewrite.

| Finding | Status | Resolution | Sections changed |
|---|---|---|---|
| P1-NEW (synthesisInFlight one-way) | Closed | Bidirectional lock: `runDeliberation` and `SessionReset.reset` check `synthesisInFlight` and reject with appropriate transient/persistent message | §7, §12 |
| P1-REGRESSED (segment-index off by one) | Closed | Aligned formula with `session-reset.ts:172`: `existing.length > 0 ? max+1 : length-1`, with "existing" pulling from BOTH reset and artifact tables | §8 |
| P1-REGRESSED (transaction can't roll back in-memory seal) | Closed | Manual rollback via new `unsealCurrentSegment` if INSERT throws (parallel to `session-reset.ts:190`) | §3, §8, §12 |
| P1-REGRESSED (`provider.invoke()` doesn't exist) | Closed | Use real method `provider.chat(messages, options)`. New helper constructs `ProviderMessage[] + ChatOptions` directly | §5, §8 |
| P1-REGRESSED (timeout API fictional) | Closed | Caller-side `Promise.race(provider.chat, setTimeout)` with `ProviderTimeoutError`; underlying fetch not cancelled (acceptable trade-off, documented) | §5, §8 |
| P1-REGRESSED (isHardFail mis-classifies CustomProvider transient) | Closed | One-line fix to `CustomProvider` to attach `.status` to thrown error; `isHardFail` reads `.status` consistently across all providers | §5, §8, §12 |
| P1-REGRESSED (chunking invariant 9 stale) | Closed | Rewrote invariant 9 to match §9 algorithm exactly; explicit cases for empty / 4096 / 4097 / 5000-char-token / multi-paragraph | §11 |
| P2-NEW (`lastSealedSegmentIndex` undefined) | Closed | Renamed to `lastSealedArtifactSegmentIndex`, defined as artifact-DB query returning `number \| null`, fast-path handles null | §4, §8 |
| P2-NEW (stale `segment_id` wording) | Closed | Replaced `segment_id` with `segment_index` in §0 non-goals and §3 architecture flow | §0, §3 |
| P2-NEW (EventMap listener mutation convention) | Closed | §4 explicit convention; new test invariant 11 (static-analysis listener scan) | §4, §11 |

## 19. Known Open Items (deferred to writing-plans / implementation)

These are real questions that surfaced in spec review (Codex rounds 8-10) but were judged not load-bearing for the design contract — the answer affects HOW to wire things, not WHAT the system does. Each must be resolved during the `writing-plans` skill phase before TDD tasks are written.

### 19.1 Cross-module segment-counter helper placement (Codex round 10 P2-2)

**Question**: §4 introduces `ArtifactService.lastSealedSegmentIndex(threadId)` (joins `session_reset_snapshots` + `council_artifacts`). §12 says `SessionReset.reset` must use the same cross-table union formula at `session-reset.ts:172`. But `SessionReset` currently has no `artifactDb` dependency. How does it read `council_artifacts`?

**Three viable approaches** (writing-plans must pick one):

- **A. Shared module helper.** Extract `computeNextSegmentIndex(threadId, resetDb, artifactDb, handler)` into a new `src/council/segment-counter.ts`. Both `ArtifactService.synthesize` and `SessionReset.reset` import it. Keeps both seal sites symmetrically thin; cost is one new module + threading two DB refs into the helper.
- **B. Inject `artifactDb` into `SessionReset`.** Add `artifactDb: ArtifactDB` to `SessionReset` constructor, update `src/index.ts` wiring, change `:172` to inline the union. No new module; cost is `SessionReset` gains a knowledge surface it didn't have before.
- **C. Late-bound singleton.** `artifactDb` is module-singleton-style (already true for several DB layers), import directly at `:172`. Lowest diff but adds an implicit coupling that differs from how `resetDb` is currently passed in.

Default recommendation for writing-plans: **A** (explicit helper, no new injected dependencies, single source of truth for the formula). Documented here because the design doesn't fall apart if it ends up being B or C — only because the test surface differs.

### 19.2 Status of `effectiveRoleType` helper

§5 introduces `effectiveRoleType(w)` to handle optional `roleType`. §12 uses it at three sites in `src/index.ts`. The helper must live somewhere reachable by both `src/index.ts` and `src/council/artifact-service.ts` (for §12 line 2 `agents.find` extraction). Likely home: `src/types.ts` (next to `WorkerRoleType`) or a new tiny `src/council/roles.ts`. writing-plans picks; either is fine.

### 19.3 Items intentionally NOT open

The following were raised by codex review and explicitly resolved in spec, NOT punted to writing-plans:

- Concurrent retry storm under provider hang (round 9 P2-3) — accepted as known limitation, documented in §5; v0.5.3+ AbortSignal threading.
- OpenAI empty-completion sentinel rewrite (round 10 P2-3) — closed via `isProviderEmptyResponse` in §8.
- Telegram listener fallback to synthesizer config (round 10 P2-1) — closed via `pickFirstPeerConfig` in §12.
