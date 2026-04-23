import { randomUUID } from 'node:crypto';
import type { ResetSnapshotDB } from '../storage/reset-snapshot-db.js';
import type { CouncilMessage, ResetSnapshot } from '../types.js';
import { buildResetSummaryPrompt, parseSummaryMetadata } from './session-reset-prompts.js';
import { BlindReviewActiveError } from './session-reset-errors.js';

export interface HandlerForReset {
  getCurrentSegmentMessages(threadId: number): readonly CouncilMessage[];
  getSegments(threadId: number): readonly { snapshotId: string | null }[];
  getBlindReviewSessionId(threadId: number): string | null;
  getCurrentTopic(threadId: number): string;
  isResetInFlight(threadId: number): boolean;
  setResetInFlight(threadId: number, v: boolean): void;
  sealCurrentSegment(threadId: number, snapshotId: string): void;
  openNewSegment(threadId: number): void;
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

    if (handler.isResetInFlight(threadId)) {
      throw new Error(`reset in progress for thread ${threadId}`);
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
      const segmentIndex = handler.getSegments(threadId).length - 1;

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

      try {
        handler.sealCurrentSegment(threadId, snapshotId);
        handler.openNewSegment(threadId);
      } catch (err) {
        this.db.deleteSnapshot(snapshotId);
        throw err;
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
}
