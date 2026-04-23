import { describe, it, expect, vi } from 'vitest';
import { SessionReset } from '../../src/council/session-reset.js';
import { ResetSnapshotDB } from '../../src/storage/reset-snapshot-db.js';
import {
  BlindReviewActiveError,
  DeliberationInProgressError,
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
} = {}) {
  const segments: MutableSegment[] = [
    {
      startedAt: '2026-04-23T09:00:00Z',
      endedAt: null,
      messages: init.messages ?? [],
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
    const reset = new SessionReset(db, facilitator as never);

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
    const reset = new SessionReset(db, facilitator as never);

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
    const reset = new SessionReset(db, facilitator as never);

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
    const reset = new SessionReset(db, facilitator as never);

    await expect(reset.reset(handler as never, T)).rejects.toThrow('boom');
    expect(handler.sealCurrentSegment).not.toHaveBeenCalled();
    expect(handler.openNewSegment).not.toHaveBeenCalled();
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
    const reset = new SessionReset(db, facilitator as never);

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
    const reset = new SessionReset(db, facilitator as never);

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
    const reset = new SessionReset(db, facilitator as never);

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
    const reset = new SessionReset(db, facilitator as never);

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
    const reset = new SessionReset(db, facilitator as never);

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
    const reset = new SessionReset(db, facilitator as never);

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
    const reset = new SessionReset(db, facilitator as never);

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
    const reset = new SessionReset(db, facilitator as never);

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
    const reset = new SessionReset(db, facilitator as never);

    await expect(reset.reset(handler as never, T)).rejects.toMatchObject({
      message: 'seal failed',
      cause: expect.any(Error),
    });
  });
});
