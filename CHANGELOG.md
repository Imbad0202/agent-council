# Changelog

All notable changes to this project will be documented in this file.

## [0.3.0] - 2026-04-15

### Added
- `sneaky-prover` agent role (7th in the `AgentRole` union). Inspired by Kirchner et al. 2024 *Prover-Verifier Games*. The role generates plausible-but-wrong responses to stress-test the council's verification capability.
- `/stresstest <message>` Telegram command. Randomly assigns sneaky-prover to one agent for the round.
- `src/council/sneaky-prover.ts` — trailer parser, debrief formatter, RNG-injectable target picker.
- `assignRoles(..., options?: {allowSneaky?: boolean})` opt-in guard. Throws if sneaky-prover is assigned without explicit consent.
- End-of-round `🔒 [SNEAKY DEBRIEF]` broadcast to the group chat after a stress-test round, revealing what error was planted.

### Changed
- `CouncilMessage.stressTest?: boolean` added to types.
- `createCouncilMessageFromTelegram` accepts an optional `{stressTest?: boolean}` second argument.
