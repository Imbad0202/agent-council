import { describe, it, expect, vi } from 'vitest';
import { SessionReset } from '../../src/council/session-reset.js';
import { ResetSnapshotDB } from '../../src/storage/reset-snapshot-db.js';
import { ArtifactDB } from '../../src/council/artifact-db.js';
import {
  BlindReviewActiveError,
  DeliberationInProgressError,
  EmptySegmentError,
  MalformedResetSummaryError,
  ResetInProgressError,
} from '../../src/council/session-reset-errors.js';
import type { CouncilMessage } from '../../src/types.js';

const T = 42;

function makeFacilitator(summary: string) {
  return {
    respondDeterministic: vi.fn(async () => ({
      content: summary,
      tokensUsed: { input: 100, output: 50 },
    })),
  };
}

interface MutableSegment {
  startedAt: string;
  endedAt: string | null;
  messages: CouncilMessage[];
  snapshotId: string | null;
}

function makeHandler(init: {
  messages?: CouncilMessage[];
  blindReviewSessionId?: string | null;
  topic?: string;
  resetInFlight?: boolean;
  deliberationInFlight?: boolean;
  pendingClassifications?: number;
} = {}) {
  // Default to a single human turn so existing tests don't trip on the
  // round-10 empty-segment guard. Tests that want to exercise the empty
  // path explicitly pass `messages: []`. Sentinel content string makes
  // it greppable if a future test accidentally relies on this default.
  const defaultMessages: CouncilMessage[] = [
    { id: 'default-turn', role: 'human', content: 'TEST_DEFAULT_TURN_ROUND10_GUARD', timestamp: 1 },
  ];
  const segments: MutableSegment[] = [
    {
      startedAt: '2026-04-23T09:00:00Z',
      endedAt: null,
      messages: init.messages ?? defaultMessages,
      snapshotId: null,
    },
  ];
  let resetInFlight = init.resetInFlight ?? false;
  const deliberationInFlight = init.deliberationInFlight ?? false;
  return {
    getCurrentSegmentMessages: vi.fn<
      [number],
      readonly CouncilMessage[]
    >(() => segments[segments.length - 1].messages),
    getSegments: vi.fn(() => segments),
    getBlindReviewSessionId: vi.fn(() => init.blindReviewSessionId ?? null),
    getCurrentTopic: vi.fn(() => init.topic ?? 'rust vs go'),
    isResetInFlight: vi.fn(() => resetInFlight),
    isDeliberationInFlight: vi.fn(() => deliberationInFlight),
    hasPendingClassifications: vi.fn(() => (init.pendingClassifications ?? 0) > 0),
    isSynthesisInFlight: vi.fn(() => false),
    setResetInFlight: vi.fn((_: number, v: boolean) => {
      resetInFlight = v;
    }),
    sealCurrentSegment: vi.fn((_: number, id: string) => {
      const last = segments[segments.length - 1];
      last.endedAt = '2026-04-23T10:00:00Z';
      last.snapshotId = id;
    }),
    openNewSegment: vi.fn(() => {
      segments.push({
        startedAt: '2026-04-23T10:00:01Z',
        endedAt: null,
        messages: [],
        snapshotId: null,
      });
    }),
    unsealCurrentSegment: vi.fn(() => {
      const last = segments[segments.length - 1];
      last.endedAt = null;
      last.snapshotId = null;
    }),
  };
}

const VALID_SUMMARY = [
  '## Decisions',
  '- ship rust',
  '',
  '## Open Questions',
  '- coverage?',
  '',
  '## Evidence Pointers',
  '- turn 4',
  '',
  '## Blind-Review State',
  'none',
  '',
].join('\n');

describe('SessionReset', () => {
  it('happy path: persist → seal → open', async () => {
    const db = new ResetSnapshotDB(':memory:');
    const facilitator = makeFacilitator(VALID_SUMMARY);
    const handler = makeHandler({
      messages: [{ id: 'm1', role: 'human', content: 'debate', timestamp: 1 }],
    });
    const artifactDb = new ArtifactDB(':memory:');
    const reset = new SessionReset(db, artifactDb, facilitator as never);

    const result = await reset.reset(handler as never, T);

    expect(result.metadata.decisionsCount).toBe(1);
    expect(result.metadata.openQuestionsCount).toBe(1);
    expect(handler.sealCurrentSegment).toHaveBeenCalledWith(T, result.snapshotId);
    expect(handler.openNewSegment).toHaveBeenCalledWith(T);
    expect(db.getSnapshot(result.snapshotId)).not.toBeNull();
  });

  it('throws BlindReviewActiveError if blind-review pending, no facilitator call, no DB write, no mutation', async () => {
    const db = new ResetSnapshotDB(':memory:');
    const facilitator = makeFacilitator(VALID_SUMMARY);
    const handler = makeHandler({ blindReviewSessionId: 'br-active' });
    const artifactDb = new ArtifactDB(':memory:');
    const reset = new SessionReset(db, artifactDb, facilitator as never);

    await expect(reset.reset(handler as never, T)).rejects.toBeInstanceOf(BlindReviewActiveError);
    expect(facilitator.respondDeterministic).not.toHaveBeenCalled();
    expect(handler.sealCurrentSegment).not.toHaveBeenCalled();
    expect(handler.openNewSegment).not.toHaveBeenCalled();
    expect(db.listSnapshotsForThread(T)).toHaveLength(0);
  });

  it('calls facilitator via respondDeterministic (not respond)', async () => {
    const db = new ResetSnapshotDB(':memory:');
    const facilitator = makeFacilitator(VALID_SUMMARY);
    const handler = makeHandler();
    const artifactDb = new ArtifactDB(':memory:');
    const reset = new SessionReset(db, artifactDb, facilitator as never);

    await reset.reset(handler as never, T);

    expect(facilitator.respondDeterministic).toHaveBeenCalledTimes(1);
    const [messages, role] = facilitator.respondDeterministic.mock.calls[0];
    expect(role).toBe('synthesizer');
    expect(messages[messages.length - 1].content).toContain('## Decisions');
  });

  it('does not mutate handler state if facilitator call fails', async () => {
    const db = new ResetSnapshotDB(':memory:');
    const facilitator = {
      respondDeterministic: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const handler = makeHandler();
    const artifactDb = new ArtifactDB(':memory:');
    const reset = new SessionReset(db, artifactDb, facilitator as never);

    await expect(reset.reset(handler as never, T)).rejects.toThrow('boom');
    expect(handler.sealCurrentSegment).not.toHaveBeenCalled();
    expect(handler.openNewSegment).not.toHaveBeenCalled();
    expect(db.listSnapshotsForThread(T)).toHaveLength(0);
  });

  // Round-16 codex finding [P2-VALIDATION]: SessionReset used to commit
  // whatever markdown the facilitator returned. parseSummaryMetadata is
  // purely structural — if the LLM emitted "### Decisions" instead of
  // "## Decisions" or skipped a section, it silently returned zero counts
  // and the malformed snapshot was still persisted. From that point
  // /councilhistory was wrong AND every future /councilreset on the
  // thread carried the bad summary forward via buildPriorSummariesBlock.
  // Snowball effect — one LLM format drift poisons all subsequent resets.
  // Fix: validate all four required H2 sections are present before
  // persist; throw MalformedResetSummaryError so the existing rollback
  // semantics apply (no DB write, no in-memory mutation, /councilreset
  // stays retry-safe).
  it('throws MalformedResetSummaryError if facilitator response is missing required sections; no DB write, no mutation', async () => {
    const db = new ResetSnapshotDB(':memory:');
    // Facilitator returns markdown that LOOKS plausible but uses ### instead
    // of ## — parseSummaryMetadata silently returned 0/0 in this case.
    const malformedSummary = [
      '### Decisions',
      '- ship rust',
      '',
      '### Open Questions',
      '- coverage?',
      '',
    ].join('\n');
    const facilitator = makeFacilitator(malformedSummary);
    const handler = makeHandler();
    const artifactDb = new ArtifactDB(':memory:');
    const reset = new SessionReset(db, artifactDb, facilitator as never);

    await expect(reset.reset(handler as never, T)).rejects.toBeInstanceOf(
      MalformedResetSummaryError,
    );
    expect(handler.sealCurrentSegment).not.toHaveBeenCalled();
    expect(handler.openNewSegment).not.toHaveBeenCalled();
    expect(db.listSnapshotsForThread(T)).toHaveLength(0);
  });

  it('throws MalformedResetSummaryError if a required section is missing entirely; no DB write', async () => {
    const db = new ResetSnapshotDB(':memory:');
    // Missing the "## Blind-Review State" section.
    const incompleteSummary = [
      '## Decisions',
      '- ship rust',
      '',
      '## Open Questions',
      '- coverage?',
      '',
      '## Evidence Pointers',
      '- turn 4',
      '',
    ].join('\n');
    const facilitator = makeFacilitator(incompleteSummary);
    const handler = makeHandler();
    const artifactDb = new ArtifactDB(':memory:');
    const reset = new SessionReset(db, artifactDb, facilitator as never);

    await expect(reset.reset(handler as never, T)).rejects.toBeInstanceOf(
      MalformedResetSummaryError,
    );
    expect(db.listSnapshotsForThread(T)).toHaveLength(0);
  });

  it('does not mutate handler state if DB write fails', async () => {
    // Pre-round-6 this was triggered by pre-seeding a row at segment_index=0
    // to force a UNIQUE collision. That collision path is now prevented by
    // computing segmentIndex as max(existing)+1, so we induce the failure
    // directly via a recordSnapshot spy instead.
    const db = new ResetSnapshotDB(':memory:');
    vi.spyOn(db, 'recordSnapshot').mockImplementation(() => {
      throw new Error('db write failed');
    });
    const facilitator = makeFacilitator(VALID_SUMMARY);
    const handler = makeHandler();
    const artifactDb = new ArtifactDB(':memory:');
    const reset = new SessionReset(db, artifactDb, facilitator as never);

    await expect(reset.reset(handler as never, T)).rejects.toThrow('db write failed');
    expect(handler.sealCurrentSegment).not.toHaveBeenCalled();
    expect(handler.openNewSegment).not.toHaveBeenCalled();
    // No rows made it in since the spy threw.
    vi.restoreAllMocks();
    expect(db.listSnapshotsForThread(T)).toHaveLength(0);
  });

  it('rollback: sealCurrentSegment throws after DB write → snapshot deleted', async () => {
    const db = new ResetSnapshotDB(':memory:');
    const facilitator = makeFacilitator(VALID_SUMMARY);
    const handler = makeHandler();
    handler.sealCurrentSegment.mockImplementation(() => {
      throw new Error('seal failed');
    });
    const artifactDb = new ArtifactDB(':memory:');
    const reset = new SessionReset(db, artifactDb, facilitator as never);

    await expect(reset.reset(handler as never, T)).rejects.toThrow('seal failed');
    expect(db.listSnapshotsForThread(T)).toHaveLength(0);
  });

  it('rollback: openNewSegment throws → snapshot deleted AND seal reverted', async () => {
    const db = new ResetSnapshotDB(':memory:');
    const facilitator = makeFacilitator(VALID_SUMMARY);
    const handler = makeHandler();
    handler.openNewSegment.mockImplementation(() => {
      throw new Error('open failed');
    });
    const artifactDb = new ArtifactDB(':memory:');
    const reset = new SessionReset(db, artifactDb, facilitator as never);

    await expect(reset.reset(handler as never, T)).rejects.toThrow('open failed');
    expect(db.listSnapshotsForThread(T)).toHaveLength(0);
    // Seal must be rolled back so the thread isn't stuck writing into a
    // sealed segment (round-5 finding 1).
    expect(handler.unsealCurrentSegment).toHaveBeenCalledWith(T);
    const segs = handler.getSegments(T);
    expect(segs[segs.length - 1].endedAt).toBeNull();
    expect(segs[segs.length - 1].snapshotId).toBeNull();
  });

  it('refuses concurrent reset (ResetInProgressError)', async () => {
    const db = new ResetSnapshotDB(':memory:');
    const facilitator = makeFacilitator(VALID_SUMMARY);
    const handler = makeHandler({ resetInFlight: true });
    const artifactDb = new ArtifactDB(':memory:');
    const reset = new SessionReset(db, artifactDb, facilitator as never);

    await expect(reset.reset(handler as never, T)).rejects.toBeInstanceOf(ResetInProgressError);
    expect(facilitator.respondDeterministic).not.toHaveBeenCalled();
  });

  it('throws DeliberationInProgressError if deliberation in flight; no facilitator call, no DB write, no mutation', async () => {
    // Round-7 finding: without this guard, a /councilreset call that lands
    // mid-deliberation would seal a segment whose transcript is still
    // growing, producing a snapshot that diverges from the sealed content.
    const db = new ResetSnapshotDB(':memory:');
    const facilitator = makeFacilitator(VALID_SUMMARY);
    const handler = makeHandler({ deliberationInFlight: true });
    const artifactDb = new ArtifactDB(':memory:');
    const reset = new SessionReset(db, artifactDb, facilitator as never);

    await expect(reset.reset(handler as never, T)).rejects.toBeInstanceOf(
      DeliberationInProgressError,
    );
    expect(facilitator.respondDeterministic).not.toHaveBeenCalled();
    expect(handler.sealCurrentSegment).not.toHaveBeenCalled();
    expect(handler.openNewSegment).not.toHaveBeenCalled();
    expect(db.listSnapshotsForThread(T)).toHaveLength(0);
  });

  it('throws DeliberationInProgressError if classifications are pending; no facilitator call, no DB write, no mutation', async () => {
    // Round-11 codex finding [P1]: between EventBus.emit('message.received')
    // and IntentGate's async classify() resolving with intent.classified, the
    // message is "in flight" but isDeliberationInFlight() still returns false.
    // A /councilreset landing in that window would seal the segment before the
    // queued message gets pushed in by runDeliberation, so the message ends up
    // in the new (post-reset) segment instead of the sealed one — breaking
    // the snapshot-covers-everything-sent-before guarantee.
    //
    // Same DeliberationInProgressError type as the in-flight guard: the user
    // remediation is identical ("wait, then retry"), and a separate error
    // would force adapters to branch for no behavioural reason.
    const db = new ResetSnapshotDB(':memory:');
    const facilitator = makeFacilitator(VALID_SUMMARY);
    const handler = makeHandler({ pendingClassifications: 1 });
    const artifactDb = new ArtifactDB(':memory:');
    const reset = new SessionReset(db, artifactDb, facilitator as never);

    await expect(reset.reset(handler as never, T)).rejects.toBeInstanceOf(
      DeliberationInProgressError,
    );
    expect(facilitator.respondDeterministic).not.toHaveBeenCalled();
    expect(handler.sealCurrentSegment).not.toHaveBeenCalled();
    expect(handler.openNewSegment).not.toHaveBeenCalled();
    expect(db.listSnapshotsForThread(T)).toHaveLength(0);
  });

  it('sets reset-in-flight before facilitator call and clears it on success', async () => {
    const db = new ResetSnapshotDB(':memory:');
    const facilitator = makeFacilitator(VALID_SUMMARY);
    const handler = makeHandler();
    const artifactDb = new ArtifactDB(':memory:');
    const reset = new SessionReset(db, artifactDb, facilitator as never);

    await reset.reset(handler as never, T);

    expect(handler.setResetInFlight).toHaveBeenCalledWith(T, true);
    expect(handler.setResetInFlight).toHaveBeenLastCalledWith(T, false);
  });

  it('clears reset-in-flight even if facilitator throws', async () => {
    const db = new ResetSnapshotDB(':memory:');
    const facilitator = {
      respondDeterministic: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const handler = makeHandler();
    const artifactDb = new ArtifactDB(':memory:');
    const reset = new SessionReset(db, artifactDb, facilitator as never);

    await expect(reset.reset(handler as never, T)).rejects.toThrow();
    expect(handler.setResetInFlight).toHaveBeenLastCalledWith(T, false);
  });

  it('after simulated restart, segmentIndex picks up from DB max + 1 (no UNIQUE collision)', async () => {
    // Simulate the round-6 scenario: a reset happened before the restart,
    // the snapshot row for (thread, segment_index=0) survived, and the
    // in-memory DeliberationHandler rebuilt with a fresh segments=[empty]
    // so its length - 1 is also 0.
    const db = new ResetSnapshotDB(':memory:');
    db.recordSnapshot({
      snapshotId: 'pre-restart',
      threadId: T,
      segmentIndex: 0,
      sealedAt: '2026-04-22T09:00:00Z',
      summaryMarkdown: VALID_SUMMARY,
      metadata: { decisionsCount: 0, openQuestionsCount: 0, blindReviewSessionId: null },
    });
    const facilitator = makeFacilitator(VALID_SUMMARY);
    const handler = makeHandler(); // segments = [one empty open segment]
    const artifactDb = new ArtifactDB(':memory:');
    const reset = new SessionReset(db, artifactDb, facilitator as never);

    const result = await reset.reset(handler as never, T);

    // Must not collide with segment_index=0; must advance to 1.
    expect(result.segmentIndex).toBe(1);
    const rows = db.listSnapshotsForThread(T);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.segmentIndex).sort()).toEqual([0, 1]);
  });

  it('if rollback cleanup (deleteSnapshot) throws, original error surfaces with cause attached', async () => {
    const db = new ResetSnapshotDB(':memory:');
    const facilitator = makeFacilitator(VALID_SUMMARY);
    const handler = makeHandler();
    handler.sealCurrentSegment.mockImplementation(() => {
      throw new Error('seal failed');
    });
    // Induce deleteSnapshot failure by closing the DB between recordSnapshot
    // and the rollback.
    const originalRecord = db.recordSnapshot.bind(db);
    vi.spyOn(db, 'recordSnapshot').mockImplementation((snap) => {
      originalRecord(snap);
      db.close();
    });
    const artifactDb = new ArtifactDB(':memory:');
    const reset = new SessionReset(db, artifactDb, facilitator as never);

    await expect(reset.reset(handler as never, T)).rejects.toMatchObject({
      message: 'seal failed',
      cause: expect.any(Error),
    });
  });

  it('caps the prior-summaries block to the last N snapshots so a long-running thread does not blow the facilitator context', async () => {
    // The carry-forward property means snapshot N already absorbs the
    // decisions from N-1. Replaying every prior snapshot on every reset
    // would grow O(n²) in cumulative tokens for no semantic gain. Verify
    // the tail-cap at 3 by seeding 5 priors and asserting the facilitator
    // sees segments 2-4 but not 0-1.
    const db = new ResetSnapshotDB(':memory:');
    for (let i = 0; i < 5; i++) {
      db.recordSnapshot({
        snapshotId: `prior-${i}`,
        threadId: T,
        segmentIndex: i,
        sealedAt: `2026-04-2${i}T09:00:00Z`,
        summaryMarkdown: [
          '## Decisions',
          `- segment-${i}-decision-marker`,
          '',
          '## Open Questions',
          '',
          '## Evidence Pointers',
          '',
          '## Blind-Review State',
          'none',
          '',
        ].join('\n'),
        metadata: { decisionsCount: 1, openQuestionsCount: 0, blindReviewSessionId: null },
      });
    }
    const facilitator = makeFacilitator(VALID_SUMMARY);
    const handler = makeHandler({
      messages: [{ id: 'm', role: 'human', content: 'live turn', timestamp: 1 }],
    });
    const artifactDb = new ArtifactDB(':memory:');
    const reset = new SessionReset(db, artifactDb, facilitator as never);

    await reset.reset(handler as never, T);

    const [messagesSent] = facilitator.respondDeterministic.mock.calls[0];
    const allContent = messagesSent.map((m: { content: string }) => m.content).join('\n\n');
    // Tail of 3 → segments 2, 3, 4 surface; 0 and 1 drop out.
    expect(allContent).not.toContain('segment-0-decision-marker');
    expect(allContent).not.toContain('segment-1-decision-marker');
    expect(allContent).toContain('segment-2-decision-marker');
    expect(allContent).toContain('segment-3-decision-marker');
    expect(allContent).toContain('segment-4-decision-marker');
  });

  it('second reset includes prior snapshot summaries so decisions are preserved across segments (round-8 codex finding)', async () => {
    // Round-8 codex finding [P1]: after the first reset, the previous segment
    // survives only as a DB snapshot (not in current-segment messages). If
    // SessionReset only feeds getCurrentSegmentMessages() to the facilitator,
    // the second reset silently drops decisions/open questions from the
    // earlier sealed segment — violating spec §6 carry-forward claim.
    const db = new ResetSnapshotDB(':memory:');

    // Seed a prior snapshot (as if /councilreset ran before).
    const priorSummary = [
      '## Decisions',
      '- adopted rust for ingest pipeline',
      '',
      '## Open Questions',
      '- retry backoff policy?',
      '',
      '## Evidence Pointers',
      '- turn 3',
      '',
      '## Blind-Review State',
      'none',
      '',
    ].join('\n');
    db.recordSnapshot({
      snapshotId: 'prior-snap',
      threadId: T,
      segmentIndex: 0,
      sealedAt: '2026-04-23T09:00:00Z',
      summaryMarkdown: priorSummary,
      metadata: { decisionsCount: 1, openQuestionsCount: 1, blindReviewSessionId: null },
    });

    const facilitator = makeFacilitator(VALID_SUMMARY);
    // Current segment only has a small new message (post-first-reset).
    const handler = makeHandler({
      messages: [{ id: 'm99', role: 'human', content: 'new debate topic', timestamp: 99 }],
    });
    const artifactDb = new ArtifactDB(':memory:');
    const reset = new SessionReset(db, artifactDb, facilitator as never);

    await reset.reset(handler as never, T);

    expect(facilitator.respondDeterministic).toHaveBeenCalledTimes(1);
    const [messagesSent] = facilitator.respondDeterministic.mock.calls[0];
    // Concatenate every content the facilitator actually sees so the assertion
    // doesn't care about prior-summary delivery shape (prepended summary msg,
    // synthetic system msg, etc.) — just that the earlier decision is there.
    const allContent = messagesSent.map((m: { content: string }) => m.content).join('\n\n');
    expect(allContent).toContain('adopted rust for ingest pipeline');
    expect(allContent).toContain('retry backoff policy?');
  });

  // Round-10 codex finding [P2]: running /councilreset on a thread with
  // zero new turns in the current segment still burned facilitator tokens,
  // persisted a snapshot row, advanced segment_index, and duplicated the
  // prior summary (because prior-summaries are replayed into the prompt).
  // Result was a bogus "reset point" polluting /councilhistory.
  it('refuses with EmptySegmentError when the current segment has no messages; no facilitator call, no DB write', async () => {
    const db = new ResetSnapshotDB(':memory:');
    const facilitator = makeFacilitator(VALID_SUMMARY);
    const handler = makeHandler({ messages: [] });
    const artifactDb = new ArtifactDB(':memory:');
    const reset = new SessionReset(db, artifactDb, facilitator as never);

    await expect(reset.reset(handler as never, T)).rejects.toBeInstanceOf(EmptySegmentError);
    expect(facilitator.respondDeterministic).not.toHaveBeenCalled();
    expect(handler.sealCurrentSegment).not.toHaveBeenCalled();
    expect(handler.openNewSegment).not.toHaveBeenCalled();
    expect(db.listSnapshotsForThread(T)).toHaveLength(0);
  });
});
