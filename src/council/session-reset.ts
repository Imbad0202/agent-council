import { randomUUID } from 'node:crypto';
import type { ResetSnapshotDB } from '../storage/reset-snapshot-db.js';
import type { ArtifactDB } from './artifact-db.js';
import type { CouncilMessage, ResetSnapshot } from '../types.js';
import {
  buildPriorSummariesBlock,
  buildResetSummaryPrompt,
  parseSummaryMetadata,
  validateResetSummaryMarkdown,
} from './session-reset-prompts.js';
import {
  BlindReviewActiveError,
  DeliberationInProgressError,
  EmptySegmentError,
  MalformedResetSummaryError,
  ResetCancelledError,
  ResetInProgressError,
  SynthesisInProgressError,
} from './session-reset-errors.js';
import { computeNextSegmentIndex } from './segment-counter.js';
import { effectiveResetSnapshots } from './effective-reset-snapshots.js';
import { mergeSignals, TimeoutReason } from '../abort-utils.js';

const RESET_OPERATION_TIMEOUT_MS = 30_000;

// Module-private. NOT exported from abort-utils.ts because it carries
// ResetCancelledError knowledge, which would invert the dependency
// (utility importing caller-specific error type).
function classifyAbort(reason: unknown): Error {
  if (reason instanceof TimeoutReason) return new ResetCancelledError('timeout');
  if (reason instanceof ResetCancelledError) return reason; // user-fired with explicit reason
  return new ResetCancelledError('user');
}

// Exported helper so unit tests in tests/council/await-reset-race.test.ts
// import THIS function instead of duplicating the catch logic in test code.
// Removing the export breaks tests at import time, locking the seam in place.
export async function awaitResetRace<T>(
  summaryPromise: Promise<T>,
  racePromise: Promise<never>,
  signal: AbortSignal,
): Promise<T> {
  try {
    return await Promise.race([summaryPromise, racePromise]);
  } catch (err) {
    // Round-2 P1-r2-1 broadening: any throw exiting Promise.race while the
    // operation is aborted gets reclassified to ResetCancelledError —
    // regardless of err shape. This handles both raw SDK abort errors
    // (APIUserAbortError, AbortError) and non-abort errors that happen to
    // race with cancel (e.g. provider 429). Non-aborted-state throws
    // propagate unchanged.
    if (signal.aborted) {
      throw classifyAbort(signal.reason);
    }
    throw err;
  }
}

export interface HandlerForReset {
  getCurrentSegmentMessages(threadId: number): readonly CouncilMessage[];
  getSegments(threadId: number): readonly { snapshotId: string | null }[];
  getBlindReviewSessionId(threadId: number): string | null;
  getCurrentTopic(threadId: number): string;
  isResetInFlight(threadId: number): boolean;
  isDeliberationInFlight(threadId: number): boolean;
  // Round-11 codex finding [P1]: a message is "in flight" between
  // EventBus.emit('message.received') and IntentGate firing intent.classified
  // (classify() is async; EventBus does not await listeners). Without this
  // signal the reset guard sees zero deliberation in flight and seals before
  // the queued message reaches runDeliberation.
  hasPendingClassifications(threadId: number): boolean;
  // v0.5.2.a bidirectional lock: /councilreset refuses while /councildone
  // synthesis is in progress to prevent segment_index collision.
  isSynthesisInFlight(threadId: number): boolean;
  setResetInFlight(threadId: number, v: boolean): void;
  sealCurrentSegment(threadId: number, snapshotId: string): void;
  openNewSegment(threadId: number): void;
  unsealCurrentSegment(threadId: number): void;
  // v0.5.4 §3.3 — per-thread reset controller (forwarded to DeliberationHandler)
  getCurrentResetController(threadId: number): AbortController | null;
  setCurrentResetController(threadId: number, controller: AbortController | null): void;
}

export interface FacilitatorForReset {
  respondDeterministic(
    messages: CouncilMessage[],
    role: 'synthesizer',
    signal?: AbortSignal, // v0.5.4 additive — lockstep with AgentWorker (round-2 P2-r2-2)
  ): Promise<{ content: string }>;
}

export interface ResetResult {
  snapshotId: string;
  summaryMarkdown: string;
  metadata: ResetSnapshot['metadata'];
  segmentIndex: number;
}

export class SessionReset {
  constructor(
    private db: ResetSnapshotDB,
    private artifactDb: ArtifactDB,
    private facilitator: FacilitatorForReset,
  ) {}

  async reset(
    handler: HandlerForReset,
    threadId: number,
    options?: { signal?: AbortSignal },
  ): Promise<ResetResult> {
    // Guard order matters: empty-segment first because it's the permanent
    // "nothing to reset" state — no point telling the user "a blind-review
    // is pending, try later" if retrying will still find zero turns to
    // summarize. The three concurrency guards after it are transient
    // "try again once X finishes" states.
    //
    // Round-10 codex finding [P2]: running /councilreset with nothing in
    // the current segment used to burn facilitator tokens, persist a
    // snapshot row, advance segment_index, and duplicate the prior
    // summary (because prior-summaries get replayed into the prompt).
    // That polluted /councilhistory with bogus reset points. Refuse early
    // so empty resets are a cheap, visible no-op.
    if (handler.getCurrentSegmentMessages(threadId).length === 0) {
      throw new EmptySegmentError();
    }

    if (handler.getBlindReviewSessionId(threadId) !== null) {
      throw new BlindReviewActiveError();
    }

    // Symmetric concurrency guard (round-7 audit + round-9 correction):
    // a deliberation round can still push agent turns into the current
    // segment between the facilitator summary call and the seal. Reset
    // refuses here; the matching "deliberation refuses while resetInFlight"
    // direction lives in DeliberationHandler.runDeliberation.
    if (handler.isDeliberationInFlight(threadId)) {
      throw new DeliberationInProgressError(threadId);
    }

    // Round-11 codex finding [P1]: pending-classification window is
    // semantically the same "deliberation is about to seal more turns"
    // condition as the in-flight guard above, so reuse the same error type.
    // The user remediation is identical (wait, retry) — branching adapters
    // on a separate error type would just duplicate code.
    if (handler.hasPendingClassifications(threadId)) {
      throw new DeliberationInProgressError(threadId);
    }

    // v0.5.2.a bidirectional lock: /councildone synthesis seals the same
    // segment — a concurrent /councilreset would produce a second snapshot
    // row targeting the same segment_index. The matching direction lives in
    // ArtifactService: it refuses while resetInFlight is true.
    if (handler.isSynthesisInFlight(threadId)) {
      throw new SynthesisInProgressError(threadId);
    }

    if (handler.isResetInFlight(threadId)) {
      throw new ResetInProgressError(threadId);
    }

    // === v0.5.4 race+abort wrap (§4.1) ===
    handler.setResetInFlight(threadId, true);
    try {
      const operationCtrl = new AbortController();
      const merged = mergeSignals(options?.signal, operationCtrl.signal)!;
      // merged is always non-null because operationCtrl.signal is always present.

      // [P1-2 fix / R0] Pre-check BEFORE constructing summaryPromise.
      // Async function bodies run synchronously up to the first await, so a
      // summaryPromise constructed before this check would call provider.chat
      // before the race could reject.
      if (merged.aborted) {
        throw classifyAbort(merged.reason);
      }

      handler.setCurrentResetController(threadId, operationCtrl);
      let timer: NodeJS.Timeout | undefined;
      try {
        // === summaryPromise body — existing reset body, with 2 changes ===
        //   (a) respondDeterministic forwards `merged` (signal forwarding)
        //   (b) [P1-1 fix / R1'] post-await abort gate before validation/persist
        const summaryPromise = (async (): Promise<ResetResult> => {
          const messages = handler.getCurrentSegmentMessages(threadId);

          // Round-8 codex finding [P1]: after the first reset, the prior segment
          // exists only as a DB snapshot. If we only feed the current-segment
          // messages to the facilitator, the second /councilreset summary silently
          // drops decisions/open questions from every earlier sealed segment.
          // Prepend the existing snapshot markdowns as a single synthetic human
          // message so the facilitator keeps rolling every prior sealed summary
          // forward into the next one.
          //
          // v0.5.2.a codex round-5 P2: use effectiveResetSnapshots so any reset
          // SUPERSEDED by a later /councildone artifact is dropped. Spec §0:
          // /councildone is a closing primitive; pre-artifact reset content
          // must NOT leak into post-artifact /councilreset prior-summary blocks.
          const existing = effectiveResetSnapshots(threadId, this.db, this.artifactDb);
          const priorSummariesMsg: CouncilMessage | null =
            existing.length > 0
              ? {
                  id: `reset-prior-summaries-${Date.now()}`,
                  role: 'human',
                  content: buildPriorSummariesBlock(existing),
                  timestamp: Date.now(),
                  threadId,
                }
              : null;

          const promptBody = buildResetSummaryPrompt({
            topic: handler.getCurrentTopic(threadId),
            turnsInSegment: messages.length,
          });
          const summaryMsg: CouncilMessage = {
            id: `reset-summary-${Date.now()}`,
            role: 'human',
            content: promptBody,
            timestamp: Date.now(),
            threadId,
          };

          const facilitatorMessages: CouncilMessage[] = [
            ...(priorSummariesMsg ? [priorSummariesMsg] : []),
            ...messages,
            summaryMsg,
          ];
          const response = await this.facilitator.respondDeterministic(
            facilitatorMessages,
            'synthesizer',
            merged,                        // ← signal forwarding (§3.1)
          );

          // [P1-1 fix / R1'] If cancel/timeout landed while LLM was in flight,
          // refuse to commit even if the SDK happened to return a complete
          // response before honoring the abort. Without this gate, a slow-to-
          // honor SDK can let the cancelled reset commit DB+segment state
          // AFTER cleanup ran — a background-write bug.
          if (merged.aborted) {
            throw classifyAbort(merged.reason);
          }

          const summaryMarkdown = response.content;

          // Round-16 codex finding [P2-VALIDATION]: validate the structural
          // contract BEFORE persist. parseSummaryMetadata silently returns 0/0
          // for malformed input, which would commit a bad snapshot row that
          // /councilhistory then surfaces as wrong AND every future
          // /councilreset on the thread carries forward via
          // buildPriorSummariesBlock. Throwing here triggers the existing
          // rollback semantics (no DB write happens after this point if we
          // throw) and leaves the thread retry-safe — the user can re-run
          // /councilreset and the facilitator's next response gets validated
          // again.
          const validation = validateResetSummaryMarkdown(summaryMarkdown);
          if (!validation.valid) {
            throw new MalformedResetSummaryError(validation.missingSections);
          }

          const parsed = parseSummaryMetadata(summaryMarkdown);
          const snapshotId = randomUUID();

          // segmentIndex is persisted as a monotonically-increasing DB metadata
          // column. v0.5.2.a: computeNextSegmentIndex checks BOTH reset_snapshots
          // and council_artifacts so the counter stays monotonic across /councilreset
          // and /councildone seals, surviving process restarts regardless of which
          // seal mechanism last ran.
          const segmentIndex = computeNextSegmentIndex(
            threadId, this.db, this.artifactDb, handler,
          );

          const snapshot: ResetSnapshot = {
            snapshotId,
            threadId,
            segmentIndex,
            sealedAt: new Date().toISOString(),
            summaryMarkdown,
            metadata: {
              decisionsCount: parsed.decisionsCount,
              openQuestionsCount: parsed.openQuestionsCount,
              blindReviewSessionId: null,
            },
          };

          this.db.recordSnapshot(snapshot);

          // Synchronous block: codex round-1 verified no await between
          // recordSnapshot and openNewSegment, so race rejection cannot
          // preempt this block.
          //
          // Seal first. If it fails, no in-memory mutation has happened yet —
          // just roll back the DB row.
          try {
            handler.sealCurrentSegment(threadId, snapshotId);
          } catch (sealErr) {
            this.safeDeleteSnapshot(snapshotId, sealErr);
            throw sealErr;
          }

          // Segment is now sealed in memory. If open fails, we must unseal to
          // prevent runDeliberation from writing into a sealed segment, then
          // roll back the DB row.
          try {
            handler.openNewSegment(threadId);
          } catch (openErr) {
            try {
              handler.unsealCurrentSegment(threadId);
            } catch {
              // Best-effort — if unseal also fails the thread is already
              // corrupt, but we still want to surface the open error.
            }
            this.safeDeleteSnapshot(snapshotId, openErr);
            throw openErr;
          }

          return {
            snapshotId,
            summaryMarkdown,
            metadata: snapshot.metadata,
            segmentIndex,
          };
        })();

        const racePromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            // Single timer drives BOTH abort and reject (v0.5.3 §5.1 site 5).
            // Reject synchronously before abort so race winner is deterministic.
            reject(new ResetCancelledError('timeout'));
            operationCtrl.abort(new TimeoutReason(RESET_OPERATION_TIMEOUT_MS));
          }, RESET_OPERATION_TIMEOUT_MS);

          // External cancel path: user-fired controller.abort() must also reject.
          // (merged.aborted at function entry was handled by the early-throw above.)
          merged.addEventListener('abort', () => {
            reject(classifyAbort(merged.reason));
          }, { once: true });
        });

        // Delegate to awaitResetRace helper (round-3 P1-r3-1 — exported helper
        // is the regression seam; tests in tests/council/await-reset-race.test.ts
        // pin its three branches).
        return await awaitResetRace(summaryPromise, racePromise, merged);
      } finally {
        // Inner cleanup: clear timer FIRST (so any late-firing setTimeout
        // callback doesn't run after controller is null), then clear controller.
        if (timer) clearTimeout(timer);
        handler.setCurrentResetController(threadId, null);
      }
    } finally {
      // Outer cleanup: clear flag last so a second /councilcancel arriving
      // during cleanup never sees `resetInFlight=false` AND a non-null
      // controller simultaneously (round-1 P2-2 ordering).
      handler.setResetInFlight(threadId, false);
    }
  }

  // Rollback cleanup. If the delete itself throws (e.g. DB already closed),
  // attach the cleanup failure as Error.cause on the original lifecycle
  // error so callers still see the root cause.
  private safeDeleteSnapshot(snapshotId: string, originalError: unknown): void {
    try {
      this.db.deleteSnapshot(snapshotId);
    } catch (deleteErr) {
      if (originalError instanceof Error && originalError.cause === undefined) {
        (originalError as { cause?: unknown }).cause = deleteErr;
      }
    }
  }
}
