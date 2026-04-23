import { describe, it, expect, vi } from 'vitest';
import { buildTestHandler } from '../helpers/deliberation-factory.js';
import { DeliberationHandler } from '../../src/council/deliberation.js';
import { EventBus } from '../../src/events/bus.js';
import { ResetSnapshotDB } from '../../src/storage/reset-snapshot-db.js';
import { makeWorker, minConfig } from './helpers.js';
import type { CouncilMessage } from '../../src/types.js';

const T = 42;
const msg = (id: string, content: string): CouncilMessage => ({
  id,
  role: 'human',
  content,
  timestamp: Date.now(),
  threadId: T,
});

describe('DeliberationHandler per-thread segments', () => {
  it('starts with a single open segment', () => {
    const { handler } = buildTestHandler();
    const segs = handler.getSegments(T);
    expect(segs).toHaveLength(1);
    expect(segs[0].endedAt).toBeNull();
    expect(segs[0].snapshotId).toBeNull();
    expect(segs[0].messages).toEqual([]);
  });

  it('sealCurrentSegment + openNewSegment', () => {
    const { handler } = buildTestHandler();
    handler.sealCurrentSegment(T, 'snap-a');
    handler.openNewSegment(T);
    const segs = handler.getSegments(T);
    expect(segs).toHaveLength(2);
    expect(segs[0].snapshotId).toBe('snap-a');
    expect(segs[0].endedAt).not.toBeNull();
    expect(segs[1].endedAt).toBeNull();
  });

  it('double-seal throws', () => {
    const { handler } = buildTestHandler();
    handler.sealCurrentSegment(T, 'snap-a');
    expect(() => handler.sealCurrentSegment(T, 'snap-b')).toThrow(/already sealed/i);
  });

  it('openNewSegment without seal throws', () => {
    const { handler } = buildTestHandler();
    expect(() => handler.openNewSegment(T)).toThrow(/must seal/i);
  });

  it('segment state is isolated per thread', () => {
    const { handler } = buildTestHandler();
    handler.sealCurrentSegment(T, 'snap-a');
    expect(handler.getSegments(99)).toHaveLength(1);
    expect(handler.getSegments(99)[0].snapshotId).toBeNull();
  });

  it('pushMessageForTest appends to current segment', () => {
    const { handler } = buildTestHandler();
    handler.pushMessageForTest(T, msg('m1', 'turn 1'));
    handler.pushMessageForTest(T, msg('m2', 'turn 2'));
    expect(handler.getCurrentSegmentMessages(T)).toHaveLength(2);
    expect(handler.getSegments(T)[0].messages).toHaveLength(2);
  });

  it('after seal + open, new messages land in segment[1] only', () => {
    const { handler } = buildTestHandler();
    handler.pushMessageForTest(T, msg('m1', 'seg0'));
    handler.sealCurrentSegment(T, 'snap-a');
    handler.openNewSegment(T);
    handler.pushMessageForTest(T, msg('m2', 'seg1'));
    expect(handler.getSegments(T)[0].messages).toHaveLength(1);
    expect(handler.getSegments(T)[1].messages).toHaveLength(1);
    expect(handler.getCurrentSegmentMessages(T)[0].content).toBe('seg1');
  });

  it('unsealCurrentSegment reverts endedAt and snapshotId', () => {
    const { handler } = buildTestHandler();
    handler.sealCurrentSegment(T, 'snap-a');
    expect(handler.getSegments(T)[0].snapshotId).toBe('snap-a');
    expect(handler.getSegments(T)[0].endedAt).not.toBeNull();
    handler.unsealCurrentSegment(T);
    expect(handler.getSegments(T)[0].snapshotId).toBeNull();
    expect(handler.getSegments(T)[0].endedAt).toBeNull();
    // After unseal, new messages still go into segment 0 (no new segment opened).
    handler.pushMessageForTest(T, msg('m1', 'post-unseal'));
    expect(handler.getSegments(T)).toHaveLength(1);
    expect(handler.getCurrentSegmentMessages(T)).toHaveLength(1);
  });

  it('unsealCurrentSegment throws if current segment is not sealed', () => {
    const { handler } = buildTestHandler();
    expect(() => handler.unsealCurrentSegment(T)).toThrow(/not sealed/i);
  });

  // Round-8 codex finding [P2]: the per-thread blindReviewSessionId guard is
  // only cleared on `blind-review.revealed`. /cancelreview never emitted
  // anything, so the flag stuck non-null for the rest of the process and
  // /councilreset kept refusing that thread forever. Listener parity with
  // `revealed` fixes it: cancel also clears the guard.
  // Round-9 codex finding [P2]: getSnapshotPrefix walked only in-memory
  // segments[]. After a process restart, the session rebuilds with a fresh
  // open segment whose snapshotId is null, so the first post-restart turn
  // on a previously reset thread got no carry-forward — even though the
  // snapshot row still lives in SQLite. Simulate restart by creating a
  // fresh DeliberationHandler that shares the same DB but has no in-memory
  // segment snapshotIds, and assert getSnapshotPrefix falls back to DB.
  it('getSnapshotPrefix falls back to the latest DB snapshot after a process restart', () => {
    const db = new ResetSnapshotDB(':memory:');
    // Pre-populate as if a /councilreset ran in a previous process.
    const priorSummary = [
      '## Decisions',
      '- ship rust',
      '',
      '## Open Questions',
      '',
      '## Evidence Pointers',
      '',
      '## Blind-Review State',
      'none',
      '',
    ].join('\n');
    db.recordSnapshot({
      snapshotId: 'prior-reset',
      threadId: T,
      segmentIndex: 0,
      sealedAt: '2026-04-22T09:00:00Z',
      summaryMarkdown: priorSummary,
      metadata: { decisionsCount: 1, openQuestionsCount: 0, blindReviewSessionId: null },
    });

    // Fresh handler — in-memory session has no snapshotIds.
    const bus = new EventBus();
    const workers = [makeWorker('agent-a', 'Agent A')];
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const handler = new DeliberationHandler(bus, workers, minConfig, sendFn, {
      resetSnapshotDB: db,
    });

    expect(handler.getSnapshotPrefix(T)).toBe(priorSummary);
  });

  // Round-11 codex finding [P1]: IntentGate.classify is async but EventBus
  // does not await it, so message.received returns to the caller before
  // intent.classified fires. SessionState.deliberationInFlight is only set
  // when runDeliberation actually starts (on intent.classified), so a
  // /councilreset landing in that gap saw zero in-flight markers and
  // sealed the segment before the queued message reached it.
  // Fix: track classifications-in-flight on SessionState. message.received
  // increments, intent.classified decrements (keyed by message.id so multiple
  // races don't underflow). hasPendingClassifications() is checked by the
  // reset guard.
  it('hasPendingClassifications flips true on message.received, false on intent.classified', () => {
    const { handler, bus } = buildTestHandler();
    const m: CouncilMessage = msg('m1', 'hello');

    expect(handler.hasPendingClassifications(T)).toBe(false);

    bus.emit('message.received', { message: m, threadId: T });
    expect(handler.hasPendingClassifications(T)).toBe(true);

    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'low',
      threadId: T,
      message: m,
    });
    expect(handler.hasPendingClassifications(T)).toBe(false);
  });

  it('hasPendingClassifications stays positive when only one of two queued messages classifies', () => {
    const { handler, bus } = buildTestHandler();
    const m1: CouncilMessage = msg('m1', 'first');
    const m2: CouncilMessage = msg('m2', 'second');

    bus.emit('message.received', { message: m1, threadId: T });
    bus.emit('message.received', { message: m2, threadId: T });
    expect(handler.hasPendingClassifications(T)).toBe(true);

    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'low',
      threadId: T,
      message: m1,
    });
    // m2 still pending — guard must still report true.
    expect(handler.hasPendingClassifications(T)).toBe(true);

    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'low',
      threadId: T,
      message: m2,
    });
    expect(handler.hasPendingClassifications(T)).toBe(false);
  });

  it('blind-review.cancelled event clears blindReviewSessionId so /councilreset is no longer blocked', () => {
    const { handler, bus } = buildTestHandler();
    // Materialize the session first — started/cancelled listeners skip when
    // the session isn't in the map yet.
    handler.getBlindReviewSessionId(T);
    bus.emit('blind-review.started', {
      threadId: T,
      codes: ['Agent-A', 'Agent-B'],
      sessionId: 'br-session-xyz',
    });
    expect(handler.getBlindReviewSessionId(T)).toBe('br-session-xyz');
    bus.emit('blind-review.cancelled', { threadId: T });
    expect(handler.getBlindReviewSessionId(T)).toBeNull();
  });
});
