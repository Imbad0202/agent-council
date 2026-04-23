import { describe, it, expect, beforeEach } from 'vitest';
import { ResetSnapshotDB } from '../../src/storage/reset-snapshot-db.js';
import type { ResetSnapshot } from '../../src/types.js';

function snapshot(overrides: Partial<ResetSnapshot> = {}): ResetSnapshot {
  return {
    snapshotId: 'snap-1',
    threadId: 42,
    segmentIndex: 0,
    sealedAt: '2026-04-23T10:00:00Z',
    summaryMarkdown:
      '## Decisions\n- ship it\n\n## Open Questions\n\n## Evidence Pointers\n\n## Blind-Review State\nnone\n',
    metadata: { openQuestionsCount: 0, decisionsCount: 1, blindReviewSessionId: null },
    ...overrides,
  };
}

describe('ResetSnapshotDB', () => {
  let db: ResetSnapshotDB;
  beforeEach(() => {
    db = new ResetSnapshotDB(':memory:');
  });

  it('creates session_reset_snapshots table on init', () => {
    expect(db.listTables()).toContain('session_reset_snapshots');
  });

  it('records and retrieves a snapshot by id', () => {
    db.recordSnapshot(snapshot());
    expect(db.getSnapshot('snap-1')).toEqual(snapshot());
  });

  it('lists snapshots for a thread in segment_index order', () => {
    db.recordSnapshot(snapshot({ snapshotId: 'a', segmentIndex: 0 }));
    db.recordSnapshot(snapshot({ snapshotId: 'b', segmentIndex: 1 }));
    expect(db.listSnapshotsForThread(42).map((s) => s.snapshotId)).toEqual(['a', 'b']);
  });

  it('enforces (thread_id, segment_index) uniqueness', () => {
    db.recordSnapshot(snapshot({ snapshotId: 'a', segmentIndex: 0 }));
    expect(() => db.recordSnapshot(snapshot({ snapshotId: 'b', segmentIndex: 0 }))).toThrow();
  });

  it('returns null for missing snapshot id', () => {
    expect(db.getSnapshot('missing')).toBeNull();
  });

  it('deletes a snapshot by id (used by rollback)', () => {
    db.recordSnapshot(snapshot());
    db.deleteSnapshot('snap-1');
    expect(db.getSnapshot('snap-1')).toBeNull();
  });

  it('deleteSnapshot on missing id is a no-op', () => {
    expect(() => db.deleteSnapshot('missing')).not.toThrow();
  });
});
