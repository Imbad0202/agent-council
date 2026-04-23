# Long-Running Council Sessions

## The problem

Past ~100 turns, agent responses start to drift. v0.4 prompt caching keeps token cost low, but caching does not fix coherence — agents echo earlier rounds, re-litigate decisions, and lose the plot. Token pressure is not the issue; semantic drift is.

## /councilreset

Produces a structured markdown summary of the current segment (`## Decisions`, `## Open Questions`, `## Evidence Pointers`, `## Blind-Review State`), persists it, seals the segment, and starts a new one. Prior turns remain readable via `/councilhistory`, but are no longer sent to agents on subsequent turns. The next-turn agent invocations see the summary as a synthetic first user message and continue from there.

CLI:

```
/councilreset
```

Telegram (in the configured group chat / thread):

```
/councilreset
```

On success the bot replies:

```
Sealed segment N: X decision(s), Y open question(s). Starting next segment.
```

## /councilhistory

Lists every reset point for the current thread with the sealed-at timestamp and metadata counts:

```
[0] 2026-04-23T09:00:00Z — 3 decisions, 1 open
[1] 2026-04-23T10:05:00Z — 2 decisions, 0 open
```

When there are no resets yet, the reply is `No resets yet in this session.`

## Guards

- **Blind-review active.** `/councilreset` refuses to run while an unrevealed blind-review session is pending on the same thread. The reply names the commands that unblock you (`/blindreview reveal` or `/cancelreview`). No facilitator tokens are burned by a refused reset.
- **Deliberation in flight.** `/councilreset` refuses while a council round is still running on the thread. Sealing mid-round would produce a snapshot that diverges from the transcript the agents actually wrote into the segment. Wait for the round to finish, then retry. The flag clears in `finally`, so a thrown agent or send error still unblocks future resets.
- **Concurrent reset.** If a reset is already in flight on the thread, a second invocation is rejected with `A /councilreset is already in progress for thread N.` The in-flight flag clears on both success and failure so the thread does not get permanently stuck.

## Provider-agnostic carry-forward

The summary is surfaced to every agent on the next turn as the first `user`-role message in the conversation history. This works uniformly for Claude, OpenAI, and Gemini peers — the snapshot rides the regular `ProviderMessage[]` transformation, not Anthropic's `systemPromptParts` cache marker. That means every post-reset turn re-pays the snapshot tokens as input. A Claude-only cache optimisation that reuses `systemPromptParts` for the snapshot is scheduled for v0.5.2.

The end-to-end guarantee is asserted in `tests/integration/reset-flow.test.ts`: after a reset, both a stub Claude provider and a stub OpenAI provider receive the reset-summary text at `messages[0].content` on the next turn.

## Multi-reset context carry-forward

On the second and later `/councilreset` on a thread, `SessionReset` replays the most recent 3 prior snapshot summaries to the facilitator as a synthetic "Prior session segments" context block. Each snapshot already absorbs the decisions from its predecessors, so tail-3 gives the same semantic content as the full history without the O(n²) token cost of replaying every prior reset on every subsequent reset. Without this carry-forward the second reset silently dropped decisions from every earlier sealed segment — caught by round-8 `codex review` formal gate.

## Recovery

The reset sequence is designed to leave no half-committed state.

1. **Facilitator call fails.** No DB write, no in-memory mutation. Safe to retry.
2. **DB `recordSnapshot` fails.** Facilitator tokens were spent but no in-memory mutation happened. Safe to retry.
3. **`sealCurrentSegment` fails (post-DB-write).** The snapshot row is rolled back automatically. Safe to retry.
4. **`openNewSegment` fails (post-seal).** The in-memory seal is reverted via `unsealCurrentSegment`, then the snapshot row is rolled back. The thread is back to its pre-reset state. Safe to retry.

If the rollback cleanup itself throws (e.g. the database handle has been closed), the original lifecycle error still surfaces to the caller — the cleanup failure is attached as `Error.cause` so neither root cause is lost.

## Design rationale

See `docs/superpowers/specs/2026-04-23-v0.5.1-session-reset-design.md` for the full design, including the post-Codex scope reduction that trimmed v0.5.1 down to the provider-agnostic prepend and deferred the cache-token instrumentation to v0.5.2.
