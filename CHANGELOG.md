# Changelog

All notable changes to this project will be documented in this file.

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
