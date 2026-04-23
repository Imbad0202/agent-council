import { describe, it, expect } from 'vitest';
import { buildTestHandler } from '../helpers/deliberation-factory.js';
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
