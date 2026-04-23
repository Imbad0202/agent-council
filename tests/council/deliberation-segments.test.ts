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
});
