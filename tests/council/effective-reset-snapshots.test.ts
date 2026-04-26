import { describe, it, expect, beforeEach } from 'vitest';
import { effectiveResetSnapshots } from '../../src/council/effective-reset-snapshots.js';
import { ResetSnapshotDB } from '../../src/storage/reset-snapshot-db.js';
import { ArtifactDB } from '../../src/council/artifact-db.js';

const THREAD = 42;

function recordReset(db: ResetSnapshotDB, segmentIndex: number, summary: string): void {
  db.recordSnapshot({
    snapshotId: `r-${segmentIndex}`,
    threadId: THREAD,
    segmentIndex,
    sealedAt: `t-${segmentIndex}`,
    summaryMarkdown: summary,
    metadata: { openQuestionsCount: 0, decisionsCount: 0, blindReviewSessionId: null },
  });
}

function recordArtifact(db: ArtifactDB, segmentIndex: number): void {
  db.insert({
    thread_id: THREAD,
    segment_index: segmentIndex,
    thread_local_seq: segmentIndex,
    preset: 'universal',
    content_md: '## TL;DR\nx',
    created_at: `t-${segmentIndex}`,
  });
}

describe('effectiveResetSnapshots', () => {
  let resetDb: ResetSnapshotDB;
  let artifactDb: ArtifactDB;

  beforeEach(() => {
    resetDb = new ResetSnapshotDB(':memory:');
    artifactDb = new ArtifactDB(':memory:');
  });

  it('returns all reset snapshots when artifactDb is undefined', () => {
    recordReset(resetDb, 0, 'r0');
    recordReset(resetDb, 1, 'r1');
    const result = effectiveResetSnapshots(THREAD, resetDb, undefined);
    expect(result.map((s) => s.summaryMarkdown)).toEqual(['r0', 'r1']);
  });

  it('returns all reset snapshots when no artifacts exist', () => {
    recordReset(resetDb, 0, 'r0');
    recordReset(resetDb, 1, 'r1');
    const result = effectiveResetSnapshots(THREAD, resetDb, artifactDb);
    expect(result.map((s) => s.summaryMarkdown)).toEqual(['r0', 'r1']);
  });

  it('drops reset snapshots that come BEFORE the latest artifact', () => {
    recordReset(resetDb, 0, 'r0-stale');
    recordReset(resetDb, 1, 'r1-stale');
    recordArtifact(artifactDb, 2);             // artifact at segment 2
    recordReset(resetDb, 3, 'r3-fresh');       // reset AFTER artifact
    const result = effectiveResetSnapshots(THREAD, resetDb, artifactDb);
    expect(result.map((s) => s.summaryMarkdown)).toEqual(['r3-fresh']);
  });

  it('drops ALL reset snapshots when the latest artifact is more recent than every reset', () => {
    recordReset(resetDb, 0, 'r0-stale');
    recordReset(resetDb, 1, 'r1-stale');
    recordArtifact(artifactDb, 2);
    const result = effectiveResetSnapshots(THREAD, resetDb, artifactDb);
    expect(result).toEqual([]);
  });

  it('keeps reset snapshots when the latest reset is more recent than every artifact', () => {
    recordArtifact(artifactDb, 0);
    recordReset(resetDb, 1, 'r1');
    recordReset(resetDb, 2, 'r2');
    const result = effectiveResetSnapshots(THREAD, resetDb, artifactDb);
    expect(result.map((s) => s.summaryMarkdown)).toEqual(['r1', 'r2']);
  });

  it('only filters within the requested thread', () => {
    recordReset(resetDb, 0, 'r0');
    recordArtifact(artifactDb, 1);
    // Different thread shouldn't affect anything
    resetDb.recordSnapshot({
      snapshotId: 'r-other',
      threadId: 999,
      segmentIndex: 100,
      sealedAt: 't',
      summaryMarkdown: 'other-thread',
      metadata: { openQuestionsCount: 0, decisionsCount: 0, blindReviewSessionId: null },
    });
    artifactDb.insert({
      thread_id: 999,
      segment_index: 200,
      thread_local_seq: 1,
      preset: 'universal',
      content_md: '## TL;DR\nx',
      created_at: 't',
    });
    const result = effectiveResetSnapshots(THREAD, resetDb, artifactDb);
    expect(result.map((s) => s.summaryMarkdown)).toEqual([]);  // r0 dropped by thread-local artifact at idx 1
  });
});
