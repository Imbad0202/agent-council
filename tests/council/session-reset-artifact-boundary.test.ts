import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionReset } from '../../src/council/session-reset.js';
import { ResetSnapshotDB } from '../../src/storage/reset-snapshot-db.js';
import { ArtifactDB } from '../../src/council/artifact-db.js';
import { makeMessage } from './helpers.js';
import type { ResetSnapshot, CouncilMessage } from '../../src/types.js';

/**
 * Codex round-5 P2 (v0.5.2.a final review): SessionReset.reset must filter
 * out reset snapshots that come BEFORE the latest /councildone artifact when
 * building `buildPriorSummariesBlock`. Spec §0: /councildone is a closing
 * primitive, pre-artifact reset content must NOT leak into post-artifact
 * /councilreset prior-summary blocks.
 *
 * The fix uses the new effectiveResetSnapshots helper at the call site in
 * SessionReset.reset (replacing the raw listSnapshotsForThread call).
 */

const THREAD = 7;

function makeStubFacilitator(receivedMessages: { messages: CouncilMessage[] }) {
  return {
    respondDeterministic: vi.fn(async (messages: CouncilMessage[]) => {
      // Capture the messages array sent to the facilitator
      receivedMessages.messages = [...messages];
      // Return a valid reset summary (passes validateResetSummaryMarkdown)
      return {
        content: [
          '## Decisions',
          '- decided X',
          '',
          '## Open Questions',
          '- what about Y?',
          '',
          '## Evidence Pointers',
          '- turn 1',
          '',
          '## Blind-Review State',
          'none',
          '',
        ].join('\n'),
      };
    }),
  };
}

function makeStubHandler(messages: CouncilMessage[]) {
  return {
    getCurrentSegmentMessages: () => messages,
    getSegments: () => [{ snapshotId: null }],
    getBlindReviewSessionId: () => null,
    getCurrentTopic: () => '',
    isResetInFlight: () => false,
    isDeliberationInFlight: () => false,
    hasPendingClassifications: () => false,
    isSynthesisInFlight: () => false,
    setResetInFlight: () => {},
    sealCurrentSegment: () => {},
    openNewSegment: () => {},
    unsealCurrentSegment: () => {},
    // v0.5.4 §3.3 — per-thread reset controller (forwarded to DeliberationHandler)
    getCurrentResetController: () => null,
    setCurrentResetController: () => {},
  };
}

describe('SessionReset — artifact boundary filter (codex round-5 P2)', () => {
  let resetDb: ResetSnapshotDB;
  let artifactDb: ArtifactDB;

  beforeEach(() => {
    resetDb = new ResetSnapshotDB(':memory:');
    artifactDb = new ArtifactDB(':memory:');
  });

  it('drops pre-artifact reset summaries from buildPriorSummariesBlock', async () => {
    // Seed: reset at segment 0 (older), artifact at segment 1 (closer),
    // then a NEW /councilreset is being run on segment 2.
    resetDb.recordSnapshot({
      snapshotId: 'r-old',
      threadId: THREAD,
      segmentIndex: 0,
      sealedAt: 't0',
      summaryMarkdown: 'STALE PRE-ARTIFACT SUMMARY (must not leak)',
      metadata: { openQuestionsCount: 0, decisionsCount: 0, blindReviewSessionId: null },
    });
    artifactDb.insert({
      thread_id: THREAD,
      segment_index: 1,
      thread_local_seq: 1,
      preset: 'universal',
      content_md: '## TL;DR\nDone.\n',
      created_at: 't1',
    });

    const captured: { messages: CouncilMessage[] } = { messages: [] };
    const facilitator = makeStubFacilitator(captured);
    const handler = makeStubHandler([makeMessage('post-artifact discussion', THREAD)]);

    const reset = new SessionReset(resetDb, artifactDb, facilitator as never);
    await reset.reset(handler as never, THREAD);

    // The facilitator MUST NOT see the pre-artifact STALE summary.
    const allContent = captured.messages.map((m) => m.content).join('\n');
    expect(allContent).not.toContain('STALE PRE-ARTIFACT SUMMARY');
  });

  it('keeps post-artifact reset summaries (sanity: filter does not strip everything)', async () => {
    // Seed: artifact at segment 0, then reset at segment 1 (AFTER artifact).
    // The reset at segment 1 should be carried forward to the next reset.
    artifactDb.insert({
      thread_id: THREAD,
      segment_index: 0,
      thread_local_seq: 1,
      preset: 'universal',
      content_md: '## TL;DR\nDone earlier.\n',
      created_at: 't0',
    });
    resetDb.recordSnapshot({
      snapshotId: 'r-fresh',
      threadId: THREAD,
      segmentIndex: 1,
      sealedAt: 't1',
      summaryMarkdown: 'FRESH POST-ARTIFACT SUMMARY (must carry forward)',
      metadata: { openQuestionsCount: 0, decisionsCount: 0, blindReviewSessionId: null },
    });

    const captured: { messages: CouncilMessage[] } = { messages: [] };
    const facilitator = makeStubFacilitator(captured);
    const handler = makeStubHandler([makeMessage('next discussion', THREAD)]);

    const reset = new SessionReset(resetDb, artifactDb, facilitator as never);
    await reset.reset(handler as never, THREAD);

    const allContent = captured.messages.map((m) => m.content).join('\n');
    expect(allContent).toContain('FRESH POST-ARTIFACT SUMMARY');
  });
});
