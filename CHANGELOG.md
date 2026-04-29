# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.5.3] - 2026-04-29

### Added

- `AbortSignal` threading from per-attempt timeouts down to the four LLM SDKs (Claude, OpenAI, Google, Custom). Closes v0.5.2 spec §5 "concurrent retry storm" known limitation.
- `ChatOptions.signal?: AbortSignal` field; conditional spread `...(signal && { signal })` matches existing optional-field style.
- `src/abort-utils.ts` (top-level): `TimeoutReason` class, `isAbortError`, `mergeSignals` (wraps `AbortSignal.any`), `isTimeoutAbort`. Recognizes Anthropic / OpenAI `APIUserAbortError` via `constructor.name`.
- `GoogleProviderTimeoutError extends ProviderTimeoutError` with user-facing disclosure baked into `message`.
- `AgentWorker.respond()` accepts optional 7th positional `signal?: AbortSignal` for the facilitator-intervention path.

### Changed

- `invokeProviderForArtifact` replaces `Promise.race(chat, timeout)` with race + signal pattern. Race remains the deterministic backstop; signal is best-effort SDK cleanup that runs in parallel.
- `isHardFail(err, provider?)` accepts optional `LLMProvider`; treats `ProviderTimeoutError` as hard fail when `provider.name === 'google'` (Google's `abortSignal` is client-side only, so retries are bounded to 1 attempt to limit cost).
- `invokeWithRetry` wraps Google `ProviderTimeoutError` into `GoogleProviderTimeoutError` so adapters' `err.message` printing surfaces the user-facing disclosure without code changes.
- `DeliberationHandler` facilitator-intervention callsite uses single-timer race+signal pattern (one `setTimeout` drives both race-reject and signal-abort; `reject()` synchronous before `abort()`; `finally { clearTimeout }`).

### Behavior

For **Claude / OpenAI / Custom**: under provider hang, billing now stops at ~1× per-attempt × MAX_ATTEMPTS sequential (instead of ~4× concurrent).

For **Google**: first synthesis timeout fails the operation immediately (no retry) and surfaces a `GoogleProviderTimeoutError` whose message explains that Google's API does not support cancelling server-side generation. Switching the synthesizer to Claude/OpenAI restores retry-on-timeout behavior.

### Notes

- v0.5.4 will extend cancellation to `respondDeterministic`, `SessionReset`, IntentGate, memory layer, and dispatcher.
- Spec: `docs/superpowers/specs/2026-04-29-v0.5.3-abortsignal-threading-design.md` (5 codex review rounds, 0 P1).

## [0.5.2] - 2026-04-26

### Added

- `/councildone [universal|decision]` user command synthesizes a TL;DR-bearing markdown artifact from the current segment's discussion, persists it, and opens a new segment. Idempotent: a second `/councildone` on an empty new segment returns the cached artifact (zero LLM calls).
- `/councilshow <id>` retrieves a previously created artifact's full content (chunked at 4096 chars on Telegram).
- New `artifact-synthesizer` worker `role_type` (excluded from the peer pool, never invoked during normal deliberation). See `docs/synthesizer-config.md`.
- Bidirectional `synthesisInFlight` lock: `/councildone` and `/councilreset` mutually exclude one another; `runDeliberation` refuses while synthesis is in flight.
- New `council_artifacts` table in `data/council.db` (additive migration).
- New `EventMap['artifact.created']` event (broadcast only).

### Changed

- `AgentConfig.roleType` is now optional `WorkerRoleType | undefined`. Use `effectiveRoleType()` to resolve `undefined` → `'peer'` at use sites.
- `src/index.ts` startup provider + listener fallback prefer the first peer config.
- `SessionReset.reset` segment-index calculation now consults BOTH `session_reset_snapshots` and `council_artifacts` via the shared `computeNextSegmentIndex` helper.
- `CustomProvider` thrown errors now carry `.status` so `isHardFail` can distinguish 4xx (hard) vs 429/5xx (retry).

### Notes

- Concurrent retry storm under provider hang is a known limitation; spec §5 documents it. v0.5.3+ AbortSignal threading is the proper fix.

## [0.5.1] - 2026-04-23

### Added

**Session reset (v0.5.1)** — Anthropic *Harness Design for Long-Running Applications* (2026-04). The `/councilreset` primitive lets users seal the current deliberation segment, persist a structured summary, and start a new segment. Prior turns remain readable via `/councilhistory` but are no longer sent to agents.

- `/councilreset` (CLI + Telegram) — facilitator produces a structured markdown summary (`## Decisions`, `## Open Questions`, `## Evidence Pointers`, `## Blind-Review State`), persists it via `ResetSnapshotDB`, seals the current segment, and opens a new one. Guarded against concurrent invocation and against running while a blind-review session is pending.
- `/councilhistory` (CLI + Telegram) — lists all reset points for the active thread with sealed-at timestamps and metadata counts.
- Provider-agnostic snapshot carry-forward — the snapshot surfaces on the next turn as the first user-role message in `conversationHistory`, working uniformly for Claude, OpenAI, and Gemini peers. Verified end-to-end in `tests/integration/reset-flow.test.ts`.
- `AgentWorker.respond()` gains an optional `snapshotPrefix?: string` sixth parameter that prepends the summary as a synthetic first user message.
- `AgentWorker.respondDeterministic()` — `temperature: 0` variant used for reset summaries (stats bookkeeping matches `respond()` so facilitator costs surface in `stats.modelUsage`).
- `DeliberationHandler.SessionState` now tracks `segments: HistorySegment[]` instead of a flat `conversationHistory: CouncilMessage[]`. Public per-thread accessors: `getSegments`, `getCurrentSegmentMessages`, `sealCurrentSegment`, `openNewSegment`, `unsealCurrentSegment`, `getSnapshotPrefix`, `getBlindReviewSessionId`, `getCurrentTopic`, `setResetInFlight`, `isResetInFlight`.
- `SessionReset` orchestrator (`src/council/session-reset.ts`) with nested rollback: DB-write failure leaves no mutation; seal failure rolls back the DB row; open failure unseals in memory and rolls back the DB row. Cleanup failures attach as `Error.cause` on the original lifecycle error.
- Named errors: `BlindReviewActiveError`, `ResetInProgressError` — adapters branch on refusal types via `instanceof` instead of regex-matching messages.
- `EventMap['deliberation.started']` gains `topic: string`; `EventMap['blind-review.started']` gains `sessionId: string`.
- `HistorySegment.messages` is `readonly` at the type level; the handler's private `currentMessages()` helper is the single mutation boundary.

### Changed

- `src/index.ts` wires `ResetSnapshotDB` + `SessionReset` at startup, passes `resetSnapshotDB` into `DeliberationHandler`, and feature-detects `setSessionResetWiring` on the adapter (narrow `SessionResetAdapter` interface, same pattern as `CritiqueUiAdapter`).
- CLI main loop now dispatches slash commands via `routeCliInput` before the deliberation router, so `/councilreset` and `/councilhistory` work on CLI as well as Telegram.
- `memoryDb` is reused between the Memory layer and `CliCommandHandler` instead of opening a second SQLite connection.

### Fixed (round-14 codex review)

- **CLI threadId is now per-process** — previously hard-coded to `0`, which meant round-9's restart-safe `getSnapshotPrefix` DB fallback would rehydrate the prior CLI run's `/councilreset` summary as shared context on every new CLI invocation, and `/councilhistory` merged unrelated CLI sessions. Each CLI process now derives a unique threadId from its startup epoch via `deriveCliThreadId` (`src/adapters/cli-dispatch.ts`). Telegram threadIds are unaffected (they already have session boundary via chat/reply-thread). **Migration note:** existing users' pre-fix snapshots remain in `data/council.db` under thread `0` but will not be visible from new CLI sessions. Drop the row or rename the DB if you need a clean slate.
- **`openNewSegment` now resets AntiSycophancyEngine** — previously only `currentTopic` was cleared on reset. Segment-scoped classification history leaked across `/councilreset`, so a prior agreement streak would trigger convergence prompts / HITL invites in the first post-reset round. Now `session.antiSycophancy.reset()` is called on `openNewSegment`, matching the "reset boundary forgets segment-scoped heuristic state" invariant introduced in round-13 for topic.

### Deferred to v0.5.2

- Claude-only cached `systemPromptParts` fast path for snapshot — v0.5.1 ships the provider-agnostic prepend only and re-pays the snapshot tokens on every post-reset turn.
- `ContextUsageTracker` + 80% passive context-usage hint (requires Anthropic Models API `max_input_tokens`).
- `ProviderResponse.tokensUsed.cacheCreationInput` / `.cacheReadInput` instrumentation — needed to *verify* cache-hit; v0.5.1 ships the feature without that metric.
- Durable `HistorySegment.messages` across process restart — snapshots survive, in-memory segments do not.
- `/councilcontract` sprint contract command.
- **Late `facilitator.intervened` race across reset boundary** — round-12 codex finding (P1-B). Fire-and-forget bus listeners that mutate session state are not covered by the `pendingClassifications` / `deliberationInFlight` / `resetInFlight` guard set, so an intervention emitted shortly after `deliberation.ended` may land in the wrong segment. v0.5.1 ships with this race documented as a known limitation in `docs/LONG_RUNNING_COUNCIL.md`; v0.5.2 will address it systemically (likely either uniform mutation accounting on `EventBus`, or moving listener mutations into a synchronous `runDeliberation` collector). Workaround: re-run `/councilreset` if a follow-up agent message references content that should have been in the prior summary.
- **Adapter-level CLI commands `/quit` `/debug` `/resume` are advertised but not implemented** — round-12 codex finding (P2 sub-issue). They are now in `CLI_COMMAND_NAMES` so they don't trigger a deliberation round, but they hit `handle()`'s "Unknown command" fallback. Implementing the actual handlers (graceful shutdown, verbose toggle, session resume) is a separate v0.5.2 task.
- **Telegram `/councilhistory` reply not chunked at 4096 chars** — round-13 codex finding (P3). Single `ctx.reply()` will start failing on a thread that accumulates a few dozen reset points. v0.5.2 will route through the existing `splitForTelegram` helper. Workaround: CLI `/councilhistory` is unaffected; or run `/councilreset` less frequently in pathological long sessions.

## [0.5.0] - 2026-04-23

### Added

**Human critique layer (#18)** — Wang & Zhang (2026) *Pedagogical partnerships with generative AI*. Post-measure + human-injectable: no pre-gate blocks the user, but the council measures collaboration depth and invites critique when it's drifting toward consensus.

- `CollaborationDepthRubric` (4 levels × 4 axes: surface / transactional / dialogic / co-constructive) in `src/shared/collaboration-depth-rubric.ts`, reusable by ARS `collaboration_depth_agent`.
- `scoreSession` pure function in `src/council/collaboration-depth.ts`, equal-weight 4 axes, output attached to `deliberation.ended` payload as optional `collaborationScore`.
- `'human-critique'` role on `CouncilMessage` with stance (`challenge` | `question` | `addPremise`) + `critiqueTarget`.
- `HumanCritiqueStore` (`src/council/human-critique-store.ts`) — pending-window primitive. Promise-based open/submit/skip lifecycle, per-thread, bot-restart clears. Owns the authoritative critique timer.
- `DeliberationHandler` now pauses between agent turns when wired with `critiqueStore`, opens a window, awaits outcome (submitted/skipped/timeout), and injects the stance + content into the next agent's context.
- 4 new events on the bus: `human-critique.requested` / `.submitted` / `.skipped` / `.invited`.
- `AntiSycophancyEngine.shouldInviteHumanCritique()` + shared `isConverging()` — convergence detector triggers invite prompts in `deliberation.ts` so the user has an obvious handle to break consensus.
- Facilitator round summary appends `協作深度：<level>` tail line, driven by `formatScoreLine`.
- Critique injection prompts extracted to `src/council/human-critique-prompts.ts` for i18n parity with `pattern-prompts.ts`.

**Telegram InlineKeyboard critique flow (#19)** — 4-button UI (Challenge / Question / Add premise / Skip). Skip resolves immediately. Stance buttons transition to `awaiting-text` phase; next free-text message becomes the critique body. Mirrors the CLI's two-stage readline picker.

- `PendingCritiqueState` (`src/telegram/critique-state.ts`) — per-thread `awaiting-button | awaiting-text` discriminated-union state machine. Includes `drain()` for graceful shutdown.
- `buildCritiqueCallback`, `buildCritiqueTextHandler`, `createTelegramCritiquePromptUser`, `CRITIQUE_CALLBACK_PATTERN` in `src/telegram/critique-callback.ts`.
- `TelegramAdapter.stop()` calls `state.drain()` so pending-state timers don't hold the event loop open past `bot.stop()`.
- `src/index.ts` uses narrow structural interfaces (`DefaultCritiquePromptAdapter`, `CritiqueUiAdapter`) for adapter feature-detection — renaming an adapter method breaks at compile time instead of failing silently (no `as any` duck-typing).

### Changed

**Timer consolidation (#20)** — Single authoritative timer in `HumanCritiqueStore`. Prior to this, `HumanCritiqueStore` and `PendingCritiqueState` each ran independent 30s timers on the same threadId, guarded only by empty-entry checks. Harmless but wasteful and a future-race trap.

- `HumanCritiqueStore` exposes `onResolved(threadId, listener)` — one-shot subscription, returns an unsubscribe. Fires immediately if no window exists (callers must subscribe after `open()`).
- `dispatchCritiqueRequest` (`src/council/human-critique-wiring.ts`) subscribes via `onResolved` and invokes the new `wiring.cancelPrompt` callback so the adapter drains its pending UI entry when the store's timer fires first.
- `PendingCritiqueState.register` no longer accepts `timeoutMs` — state is pure UI bookkeeping; `drain()` still covers shutdown.
- `HumanCritiqueStore.close()` fires listeners inside `try/catch` so a throwing subscriber can't silently drop siblings; listeners fire before resolving the window promise for read-after-close consistency.

**`BotManager.setupListener` options object (#20)** — 4 positional optionals collapsed to `(handler, wiring: { blindReview?, pvgRotate?, critiqueUi? })`.

### Tests

- 527 → 617 passing. Net: +94 tests covering critique store lifecycle, Telegram InlineKeyboard state machine, `onResolved` subscription contract, cancelPrompt store-wins-timer path, and `event-flow` integration case for mid-deliberation critique → `deliberation.ended` with non-surface collaboration level.

## [0.4.0] - 2026-04-20

### Added

**Extended thinking + Opus 4.7 alignment (#5, #6, #14)**
- `ThinkingConfig` type + optional `thinking` field on `ChatOptions`, `ProviderResponse`, and `AgentConfig`.
- Per-tier thinking config in agent YAML (`thinking.{low,medium,high}`), routed by `AgentWorker.resolveThinking(complexity)` mirroring `resolveModel`.
- `ClaudeProvider` passes `thinking` to the Anthropic SDK, forces `temperature=1` when enabled (SDK requirement), and extracts the reasoning block into the response.
- Adaptive thinking (`{type: 'adaptive'}`) for Opus 4.7, which does not support fixed `budget_tokens`. Older models that declare `budget_tokens: N` still work.
- 賓賓 upgraded to Claude Opus 4.7 on high-complexity turns with adaptive thinking; low/medium remain on lower tiers.

**Prompt caching (#8, #9)**
- `ChatOptions.systemPromptParts?: SystemPromptPart[]` for cache-aware system prompts on Claude. Callers supply both the plain `systemPrompt` (unchanged contract) and the optional parts array.
- Stable prefix (identity + memory index + council rules) marked `cache_control: ephemeral`; the per-turn role directive lives in a second non-cached part. First turn pays full input tokens; subsequent turns in the same session hit the prefix cache.
- `cache_system_prompt: true` opt-in on 賓賓 and 主持人 (both called multiple times per session).
- System prompt section order changed from `Identity → Memory → Role → Rules` to `Identity → Memory → Rules → Role` so the cacheable prefix stays byte-identical across turns.
- `ClaudeProvider.toAnthropicSystem` returns typed `Anthropic.Messages.TextBlockParam[]` for compile-time SDK drift detection.

**System model centralization (#7, #10)**
- `system_models:` block in `council.yaml` for `intent_classification` and `task_decomposition` models. `IntentGate` and `ExecutionDispatcher` constructors accept the model IDs instead of hardcoding them.
- Single shared `DEFAULT_SYSTEM_MODEL` constant in `src/constants.ts` (replaces the two duplicate constants that had identical values).

**Blind-review → model routing closed loop (#11)**
- `BlindReviewDB` persists `/blindreview` scores to `data/council.db` (3-table audit trail: `blind_review_sessions`, `blind_review_events`, `blind_review_stats`). Transactional writes with rollback.
- Reveal message shows per-(agent, tier) historical sparkline and a rule-based routing recommendation when `sample_count >= 5`. User retains `council.yaml` authority; the system only suggests.
- `blind-review.persist-failed` event for DB write failures (fail-soft — reveal still sends).
- `AgentWorker.respond` returns `tierUsed` + `modelUsed` in `ProviderResponse`.
- `BlindReviewStore.recordTurn` / `getLatestTurnFor` / `attachDB` / `onPersistFailed`.
- `BlindReviewDB.rebuildStats` for drift recovery.
- New types: `AgentTier`, `BlindReview{Row,Input,Stats}`.

**PVG adversarial roles (#12)**
- Extends sneaky-prover into a four-vector Prover-Verifier Games framework (Kirchner et al. 2024):
  - `biased-prover` — availability / anchoring / confirmation / sunk-cost framing.
  - `deceptive-prover` — every fact correct, but conclusion overshoots evidence.
  - `calibrated-prover` — explicit confidence 0–1 with at least one declared unknown (honest-prover baseline).
- New Telegram commands: `/pvgbiased`, `/pvgdeceptive`, `/pvgcalibrated`.
- Unified `processAdversarialResponse` dispatcher so `deliberation.ts` has one strip-branch and one debrief broadcast across all four vectors.
- `allowAdversarial` opt-in guard parallel to `allowSneaky`.
- Shared `escapeRegex` helper and `AdversarialMode` type; `AgentRole` cast replaced with exhaustive `ADVERSARIAL_MODE_TO_ROLE` record.

**PVG rotation mode (#13)**
- `/pvgrotate` — random PVG vector per round (one of sneaky / biased / deceptive / calibrated). User identifies the planted vector via a 4-button inline keyboard; the actual role is revealed only after the guess is recorded.
- `PvgRotateStore` (in-memory per-thread) + `PvgRotateDB` (`pvg_rotate_rounds` table on shared `data/council.db`), mirroring the blind-review pattern.
- Non-PVG agents are forced to `critic` role in rotation mode — the council's job becomes verification, not advocacy.
- `ROTATION_STEALTH_PREAMBLE` injected only for adversarial roles in rotation mode, to suppress first-person tells that would telegraph the vector.
- `CouncilMessage.pvgRotate?: boolean` flag.
- Reveal shows guess vs actual, debrief line, per-vector running hit stats, and weakest-vector callout.

### Changed

- `@anthropic-ai/sdk`: 0.52 → 0.90 (required for `ThinkingConfigAdaptive`).
- Model ID sweep: `opus-4-6` → `opus-4-7`, `sonnet-4-5` → `sonnet-4-6`, `claude-3-5-*` / `haiku-*` → `sonnet-4-6` (per no-haiku policy) across config/, src/, tests/, docs/, examples/.
- `detection_model`, `intent_classification`, and `task_decomposition` defaults: `claude-haiku-4-5-*` → `claude-sonnet-4-6`.
- Personality prompts rewritten from negative framing (`必須精簡不超過 X 字`) to positive examples per Opus 4.7 guidance (huahua, facilitator).
- `formatRevealMessage` signature gained an optional `FormatRevealOptions` bag (`db`, `modelConfigForAgent`); callers without the bag get the prior behavior.
- `BlindReviewSession` gained `turnLog` and `feedbackText` fields.
- `SystemModelsConfig` inner fields are no longer double-optional — the loader fills defaults, and `index.ts` drops its `?.` chain.

### Fixed

- `ClaudeProvider` now throws when a caller explicitly supplies a non-1 temperature alongside `thinking`, instead of silently coercing to 1. Omitting `temperature` still defaults to 1.
- `thinking.<tier>.budget_tokens` YAML values are validated at `loadAgentConfig` time (rejects strings like `"32k"` with a quoted error) instead of surfacing an opaque Anthropic API error at first call.

### Security

- `protobufjs` 7.5.4 → 7.5.5 via `npm audit fix` to resolve [GHSA-xq3m-2v4x-88gg](https://github.com/advisories/GHSA-xq3m-2v4x-88gg) (arbitrary code execution, critical severity; transitive dep through `@google/genai`). Lock-file-only change.

### Tests

- 527 passing (up from 414 at v0.3.1).

## [0.3.1] - 2026-04-15

### Fixed
- `formatRevealMessage` now uses the per-round role from `BlindReviewSession.agentIdToRole` instead of the `'tbd'` placeholder set at startup in `agentMeta`. Previously every blind-review reveal showed `role: tbd` for all agents.
- Stress-test branch in `deliberation.ts` no longer calls `assignRoles` twice (the first result was discarded).
- `blind-review.scored` and `blind-review.revealed` events are now actually emitted (declared in `EventMap` but never fired).
- `br-score:` callback regex tightened (`(.+)` → `[^:]+`) to prevent future code formats containing `:` from being mis-parsed.

### Changed
- `SNEAKY_TRAILER_PREFIX` extracted as a single source of truth shared by the parser regex and the directive prompt (drift risk eliminated).
- `buildStressTestHandler` and `buildBlindReviewHandler` deduplicated via private `buildCommandHandler` factory in `src/telegram/bot.ts`.
- `OutputAdapter` interface gained optional `sendMessageWithKeyboard` and `setBlindReviewWiring` capability fields; `src/index.ts` now duck-types instead of `instanceof TelegramAdapter`.
- `DeliberationHandler` constructor's trailing optional positional params (`facilitatorWorker`, `sendKeyboardFn`) consolidated into a single options bag at position 5.

### Docs
- `BlindReviewStore` lifecycle documented (revealed sessions are kept, not deleted, so post-reveal `/cancelreview` is a safe no-op).

## [0.3.0] - 2026-04-15

### Added
- `sneaky-prover` agent role (7th in the `AgentRole` union). Inspired by Kirchner et al. 2024 *Prover-Verifier Games*. The role generates plausible-but-wrong responses to stress-test the council's verification capability.
- `/stresstest <message>` Telegram command. Randomly assigns sneaky-prover to one agent for the round.
- `src/council/sneaky-prover.ts` — trailer parser, debrief formatter, RNG-injectable target picker.
- `assignRoles(..., options?: {allowSneaky?: boolean})` opt-in guard. Throws if sneaky-prover is assigned without explicit consent.
- End-of-round `🔒 [SNEAKY DEBRIEF]` broadcast to the group chat after a stress-test round, revealing what error was planted.
- `/blindreview <topic>` Telegram command. Runs deliberation with anonymized agent codes (Agent-A, Agent-B, ...). After the round, posts an inline-keyboard scoring panel (1-5★ per agent). When all agents scored, broadcasts a `🎭 Blind Review Reveal` message mapping codes → agent names + roles + scores.
- `/cancelreview` Telegram command — abandons a pending blind-review session for the current thread.
- `src/council/blind-review.ts` — `BlindReviewStore`, `assignCodes`, `buildScoringKeyboard`, `formatRevealMessage`.
- 3 new EventBus events: `blind-review.started`, `blind-review.scored`, `blind-review.revealed`.
- `BotManager.sendMessageWithKeyboard` for inline-keyboard messages.

### Changed
- `CouncilMessage.stressTest?: boolean` added to types.
- `createCouncilMessageFromTelegram` accepts an optional `{stressTest?: boolean}` second argument.
- `BotManager.setupListener` accepts an optional second arg `blindReviewWiring` so the listener bot can register the blind-review commands and callback.
- `DeliberationHandler` constructor accepts an optional `sendKeyboardFn` for inline-keyboard delivery.
- `CouncilMessage.blindReview?: boolean` added to types.
