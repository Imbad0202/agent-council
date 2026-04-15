# Changelog

All notable changes to this project will be documented in this file.

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
