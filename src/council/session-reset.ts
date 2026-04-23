import { randomUUID } from 'node:crypto';
import type { ResetSnapshotDB } from '../storage/reset-snapshot-db.js';
import type { CouncilMessage, ResetSnapshot } from '../types.js';
import { buildResetSummaryPrompt, parseSummaryMetadata } from './session-reset-prompts.js';
import {
  BlindReviewActiveError,
  DeliberationInProgressError,
  ResetInProgressError,
} from './session-reset-errors.js';

export interface HandlerForReset {
  getCurrentSegmentMessages(threadId: number): readonly CouncilMessage[];
  getSegments(threadId: number): readonly { snapshotId: string | null }[];
  getBlindReviewSessionId(threadId: number): string | null;
  getCurrentTopic(threadId: number): string;
  isResetInFlight(threadId: number): boolean;
  isDeliberationInFlight(threadId: number): boolean;
  setResetInFlight(threadId: number, v: boolean): void;
  sealCurrentSegment(threadId: number, snapshotId: string): void;
  openNewSegment(threadId: number): void;
  unsealCurrentSegment(threadId: number): void;
}

export interface FacilitatorForReset {
  respondDeterministic(
    messages: CouncilMessage[],
    role: 'synthesizer',
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
    private facilitator: FacilitatorForReset,
  ) {}

  async reset(handler: HandlerForReset, threadId: number): Promise<ResetResult> {
    if (handler.getBlindReviewSessionId(threadId) !== null) {
      throw new BlindReviewActiveError();
    }

    // Asymmetric concurrency guard (round-7 audit): a deliberation round
    // can still push agent turns into the current segment between the
    // facilitator summary call and the seal. Refusing the reset here lets
    // the in-flight round finish and keeps the snapshot consistent with
    // what actually lands in the sealed segment.
    if (handler.isDeliberationInFlight(threadId)) {
      throw new DeliberationInProgressError(threadId);
    }

    if (handler.isResetInFlight(threadId)) {
      throw new ResetInProgressError(threadId);
    }

    handler.setResetInFlight(threadId, true);
    try {
      const messages = handler.getCurrentSegmentMessages(threadId);
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

      const response = await this.facilitator.respondDeterministic(
        [...messages, summaryMsg],
        'synthesizer',
      );

      const summaryMarkdown = response.content;
      const parsed = parseSummaryMetadata(summaryMarkdown);
      const snapshotId = randomUUID();

      // segmentIndex is persisted as a monotonically-increasing DB metadata
      // column. Deriving it from the in-memory segments array alone would
      // collide on the UNIQUE (thread_id, segment_index) constraint after a
      // process restart, because the in-memory session rebuilds at index 0
      // while the old snapshot rows still live in SQLite. Take max(existing)+1
      // from the DB and fall back to the in-memory index only for the first
      // reset on a fresh thread.
      const existing = this.db.listSnapshotsForThread(threadId);
      const segmentIndex =
        existing.length > 0
          ? Math.max(...existing.map((s) => s.segmentIndex)) + 1
          : handler.getSegments(threadId).length - 1;

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
    } finally {
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
