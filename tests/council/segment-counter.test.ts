import { describe, it, expect, beforeEach } from 'vitest';
import { computeNextSegmentIndex } from '../../src/council/segment-counter.js';
import type { HandlerForCounter } from '../../src/council/segment-counter.js';
import { ResetSnapshotDB } from '../../src/storage/reset-snapshot-db.js';
import { ArtifactDB } from '../../src/council/artifact-db.js';

const THREAD_ID = 42;
const OTHER_THREAD = 99;

function makeResetSnap(threadId: number, segmentIndex: number, snapshotId: string) {
  return {
    snapshotId,
    threadId,
    segmentIndex,
    sealedAt: 't0',
    summaryMarkdown: '# snap',
    metadata: { openQuestionsCount: 0, decisionsCount: 0, blindReviewSessionId: null },
  };
}

function makeArtifact(threadId: number, segmentIndex: number, seq: number) {
  return {
    thread_id: threadId,
    segment_index: segmentIndex,
    thread_local_seq: seq,
    preset: 'universal' as const,
    content_md: 'x',
    created_at: 't0',
  };
}

describe('computeNextSegmentIndex', () => {
  let resetDb: ResetSnapshotDB;
  let artifactDb: ArtifactDB;
  let handler: HandlerForCounter;

  beforeEach(() => {
    resetDb = new ResetSnapshotDB(':memory:');
    artifactDb = new ArtifactDB(':memory:');
    // Default handler: one segment (length 1), so fallback => 1 - 1 = 0
    handler = { getSegments: () => [{ snapshotId: null }] };
  });

  it('scenario 1: fresh-thread fallback when both tables are empty', () => {
    // Both DBs empty — falls back to handler.getSegments(threadId).length - 1
    const result = computeNextSegmentIndex(THREAD_ID, resetDb, artifactDb, handler);
    expect(result).toBe(handler.getSegments(THREAD_ID).length - 1);
    expect(result).toBe(0);
  });

  it('scenario 2: max(existing) + 1 when only reset table has rows', () => {
    resetDb.recordSnapshot(makeResetSnap(THREAD_ID, 3, 'snap-a'));
    resetDb.recordSnapshot(makeResetSnap(THREAD_ID, 1, 'snap-b'));

    const result = computeNextSegmentIndex(THREAD_ID, resetDb, artifactDb, handler);
    expect(result).toBe(4); // max(3, 1) + 1
  });

  it('scenario 3: max(existing) + 1 when only artifact table has rows', () => {
    artifactDb.insert(makeArtifact(THREAD_ID, 7, 1));
    artifactDb.insert(makeArtifact(THREAD_ID, 2, 2));

    const result = computeNextSegmentIndex(THREAD_ID, resetDb, artifactDb, handler);
    expect(result).toBe(8); // max(7, 2) + 1
  });

  it('scenario 4: max across BOTH tables when both are populated', () => {
    // Reset table has max 5, artifact table has max 9 → cross-table max = 9
    resetDb.recordSnapshot(makeResetSnap(THREAD_ID, 5, 'snap-c'));
    resetDb.recordSnapshot(makeResetSnap(THREAD_ID, 2, 'snap-d'));
    artifactDb.insert(makeArtifact(THREAD_ID, 9, 1));
    artifactDb.insert(makeArtifact(THREAD_ID, 4, 2));

    const result = computeNextSegmentIndex(THREAD_ID, resetDb, artifactDb, handler);
    expect(result).toBe(10); // max(5, 2, 9, 4) + 1
  });

  it('scenario 5: thread scoping — another thread\'s segments do not affect the result', () => {
    // OTHER_THREAD has high segment indices in both tables
    resetDb.recordSnapshot(makeResetSnap(OTHER_THREAD, 100, 'other-snap'));
    artifactDb.insert(makeArtifact(OTHER_THREAD, 200, 1));

    // THREAD_ID has one reset row at segment_index=3
    resetDb.recordSnapshot(makeResetSnap(THREAD_ID, 3, 'my-snap'));

    const result = computeNextSegmentIndex(THREAD_ID, resetDb, artifactDb, handler);
    // Must be 4, not 101 or 201
    expect(result).toBe(4);
  });
});
