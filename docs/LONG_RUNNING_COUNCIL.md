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

- **Empty segment.** `/councilreset` refuses with `EmptySegmentError` if the current segment contains zero turns (fresh thread, or second `/councilreset` called before any new deliberation). No facilitator tokens are burned, no snapshot row is written, `/councilhistory` stays clean. This guard is checked first because it's a permanent "nothing to reset" state, not a transient "try again later" state like the guards below.
- **Blind-review active.** `/councilreset` refuses to run while an unrevealed blind-review session is pending on the same thread. The reply names the commands that unblock you (`/blindreview reveal` or `/cancelreview`). No facilitator tokens are burned by a refused reset.
- **Deliberation in flight.** `/councilreset` refuses while a council round is still running on the thread. Sealing mid-round would produce a snapshot that diverges from the transcript the agents actually wrote into the segment. Wait for the round to finish, then retry. The flag clears in `finally`, so a thrown agent or send error still unblocks future resets.
- **New messages during a reset.** Symmetrically, `runDeliberation` refuses to start a round while a reset is already in flight on the thread. The incoming human message is dropped with a notice asking the user to resend after the reset confirmation lands. This keeps the snapshot generated before the seal consistent with the transcript that actually gets sealed (round-9 codex finding).
- **Concurrent reset.** If a reset is already in flight on the thread, a second invocation is rejected with `A /councilreset is already in progress for thread N.` The in-flight flag clears on both success and failure so the thread does not get permanently stuck.

## Provider-agnostic carry-forward

The summary is surfaced to every agent on the next turn as the first `user`-role message in the conversation history. This works uniformly for Claude, OpenAI, and Gemini peers — the snapshot rides the regular `ProviderMessage[]` transformation, not Anthropic's `systemPromptParts` cache marker. That means every post-reset turn re-pays the snapshot tokens as input. A Claude-only cache optimisation that reuses `systemPromptParts` for the snapshot is scheduled for v0.5.2.

The end-to-end guarantee is asserted in `tests/integration/reset-flow.test.ts`: after a reset, both a stub Claude provider and a stub OpenAI provider receive the reset-summary text at `messages[0].content` on the next turn.

Carry-forward also survives a process restart. `DeliberationHandler.getSnapshotPrefix` first walks the in-memory `segments[]` for a snapshotId, and if nothing is found (typical fresh-process state) falls back to `ResetSnapshotDB.listSnapshotsForThread(threadId)` and returns the most-recent snapshot's `summaryMarkdown`. Round-9 codex finding — before this fallback, any process restart between `/councilreset` and the next user turn silently dropped the context the feature is meant to preserve.

## Multi-reset context carry-forward

On the second and later `/councilreset` on a thread, `SessionReset` replays the most recent 3 prior snapshot summaries to the facilitator as a synthetic "Prior session segments" context block. Each snapshot already absorbs the decisions from its predecessors, so tail-3 gives the same semantic content as the full history without the O(n²) token cost of replaying every prior reset on every subsequent reset. Without this carry-forward the second reset silently dropped decisions from every earlier sealed segment — caught by round-8 `codex review` formal gate.

## Recovery

The reset sequence is designed to leave no half-committed state.

1. **Facilitator call fails.** No DB write, no in-memory mutation. Safe to retry.
2. **DB `recordSnapshot` fails.** Facilitator tokens were spent but no in-memory mutation happened. Safe to retry.
3. **`sealCurrentSegment` fails (post-DB-write).** The snapshot row is rolled back automatically. Safe to retry.
4. **`openNewSegment` fails (post-seal).** The in-memory seal is reverted via `unsealCurrentSegment`, then the snapshot row is rolled back. The thread is back to its pre-reset state. Safe to retry.

If the rollback cleanup itself throws (e.g. the database handle has been closed), the original lifecycle error still surfaces to the caller — the cleanup failure is attached as `Error.cause` so neither root cause is lost.

## Known limitations (deferred to v0.5.2)

### Late `facilitator.intervened` may cross the reset boundary

`facilitator.intervened` events are emitted asynchronously by FacilitatorAgent and consumed via `EventBus.on('facilitator.intervened', ...)`. The listener appends the intervention into the current segment's messages. Because `EventBus.emit` does not await its listeners, a facilitator evaluation that fires shortly after `deliberation.ended` can land in the new (post-reset) segment instead of the segment it was actually responding to — or, in the narrow window between `sealCurrentSegment` and `openNewSegment`, mutate the just-sealed segment after its snapshot has already been written.

**Why we did not fix this in v0.5.1.** Caught by round-12 `codex review`. The narrow fix is "add `pendingFacilitatorEvaluations` accounting and check it from the reset guard," matching the round-11 `pendingClassifications` pattern. But the underlying mismatch is between **fire-and-forget bus listeners that mutate session state** and **a transactional reset boundary**: every new listener is one more counter the guard has to remember to consult. Five rounds of `codex review` between v0.5.0 and v0.5.1 each caught a different listener slipping through the same crack. v0.5.2 will address this systemically — see the v0.5.2 spec for the chosen approach (likely either a uniform mutation-accounting layer on EventBus, or moving listener mutations into a synchronous `runDeliberation` collector).

**Workaround.** If a follow-up agent message after `/councilreset` references content that should have been in the prior summary, run `/councilreset` again. The empty-segment guard (round-10) prevents wasted facilitator tokens if there's nothing new to summarize.

**Detection.** No automatic detection. Production telemetry should grep `currentMessages` writes for events emitted after `deliberation.ended` if the issue surfaces in practice.

### Pre-keyboard blind-review failures (resolved in v0.5.1)

For completeness: round-12 also caught a related issue where `BlindReviewStore.create()` ran but `sendKeyboardFn` never reached because an earlier await threw. That one is fixed inline — the `runDeliberation` finally block now rolls back the store entry and the per-thread guard whenever a blind-review session was started but the keyboard was not successfully posted (`blindReviewKeyboardSent` sentinel).

## Design rationale

See `docs/superpowers/specs/2026-04-23-v0.5.1-session-reset-design.md` for the full design, including the post-Codex scope reduction that trimmed v0.5.1 down to the provider-agnostic prepend and deferred the cache-token instrumentation to v0.5.2.
