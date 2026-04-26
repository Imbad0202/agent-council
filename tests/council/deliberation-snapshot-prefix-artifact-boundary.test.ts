import { describe, it, expect, vi } from 'vitest';
import { DeliberationHandler } from '../../src/council/deliberation.js';
import { EventBus } from '../../src/events/bus.js';
import { ResetSnapshotDB } from '../../src/storage/reset-snapshot-db.js';
import { ArtifactDB } from '../../src/council/artifact-db.js';
import { makeWorker, minConfig } from './helpers.js';

/**
 * Codex round-4 P2 (v0.5.2.a final review): /councildone artifact boundary
 * must not leak older reset summaries into subsequent segments.
 *
 * Pre-fix behavior of getSnapshotPrefix:
 *   - In-memory walk: skips segments with snapshotId === null
 *   - DB fallback: returns the latest reset_snapshots row's summaryMarkdown
 *
 * Both paths leak when /councildone seals a segment AFTER a /councilreset:
 *   - Walk skips the artifact-sealed segment (null snapshotId) and finds
 *     the OLDER reset segment, returning its summary.
 *   - DB fallback ignores that an artifact has been sealed since the
 *     latest reset, and still returns the reset summary.
 *
 * Spec §0 designates /councildone as a closing primitive — older context
 * MUST NOT leak past it. The fix:
 *   - In-memory walk: stop and return null on (sealed AND snapshotId null)
 *   - DB fallback: return null if any artifact's segment_index >= latest
 *     reset's segment_index
 */

describe('DeliberationHandler.getSnapshotPrefix — /councildone artifact boundary (codex round-4 P2)', () => {
  it('in-memory walk: artifact-sealed segment after reset blocks the older reset summary', () => {
    const bus = new EventBus();
    const workers = [makeWorker('agent-a', 'Agent A')];
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const resetSnapshotDB = new ResetSnapshotDB(':memory:');
    const artifactDB = new ArtifactDB(':memory:');
    const handler = new DeliberationHandler(bus, workers, minConfig, sendFn, {
      resetSnapshotDB,
      artifactDB,
    });

    const threadId = 1;

    // Seed a reset snapshot in the DB and set up segment 0 to reference it.
    resetSnapshotDB.recordSnapshot({
      snapshotId: 'reset-abc',
      threadId,
      segmentIndex: 0,
      sealedAt: '2026-04-26T10:00:00Z',
      summaryMarkdown: 'OLDER RESET SUMMARY (must not leak)',
      metadata: { openQuestionsCount: 0, decisionsCount: 0, blindReviewSessionId: null },
    });

    // Materialize session and seal segment 0 with reset snapshot id
    handler.isSynthesisInFlight(threadId);  // materialize
    handler.sealCurrentSegment(threadId, 'reset-abc');
    handler.openNewSegment(threadId);

    // Seal segment 1 as /councildone artifact (snapshotId = null per Task 12)
    handler.sealCurrentSegment(threadId, null);
    handler.openNewSegment(threadId);

    // Now segment 2 is open. getSnapshotPrefix MUST NOT leak the
    // 'OLDER RESET SUMMARY' from segment 0.
    const prefix = handler.getSnapshotPrefix(threadId);
    expect(prefix).toBeNull();
  });

  it('in-memory walk without artifact boundary: reset summary correctly carries forward', () => {
    // Sanity: the artifact-boundary fix must NOT break the existing
    // carry-forward when there's no /councildone in the segment chain.
    const bus = new EventBus();
    const workers = [makeWorker('agent-a', 'Agent A')];
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const resetSnapshotDB = new ResetSnapshotDB(':memory:');
    const artifactDB = new ArtifactDB(':memory:');
    const handler = new DeliberationHandler(bus, workers, minConfig, sendFn, {
      resetSnapshotDB,
      artifactDB,
    });

    const threadId = 2;

    resetSnapshotDB.recordSnapshot({
      snapshotId: 'reset-xyz',
      threadId,
      segmentIndex: 0,
      sealedAt: '2026-04-26T10:00:00Z',
      summaryMarkdown: 'EXPECTED RESET SUMMARY',
      metadata: { openQuestionsCount: 0, decisionsCount: 0, blindReviewSessionId: null },
    });

    handler.isSynthesisInFlight(threadId);  // materialize
    handler.sealCurrentSegment(threadId, 'reset-xyz');
    handler.openNewSegment(threadId);

    // Segment 1 is open; only a reset boundary, no artifact. Should carry forward.
    const prefix = handler.getSnapshotPrefix(threadId);
    expect(prefix).toBe('EXPECTED RESET SUMMARY');
  });

  it('DB fallback: artifact at segment_index >= latest reset suppresses reset summary', () => {
    // Post-restart scenario: in-memory session is fresh (no segments). The
    // DB has both a reset snapshot AND an artifact at a later segment_index.
    // Without the fix, the DB fallback would return the reset summary even
    // though /councildone has since closed off that history.
    const bus = new EventBus();
    const workers = [makeWorker('agent-a', 'Agent A')];
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const resetSnapshotDB = new ResetSnapshotDB(':memory:');
    const artifactDB = new ArtifactDB(':memory:');
    const handler = new DeliberationHandler(bus, workers, minConfig, sendFn, {
      resetSnapshotDB,
      artifactDB,
    });

    const threadId = 3;

    resetSnapshotDB.recordSnapshot({
      snapshotId: 'reset-r1',
      threadId,
      segmentIndex: 1,
      sealedAt: '2026-04-26T10:00:00Z',
      summaryMarkdown: 'STALE — must not leak past artifact',
      metadata: { openQuestionsCount: 0, decisionsCount: 0, blindReviewSessionId: null },
    });
    artifactDB.insert({
      thread_id: threadId,
      segment_index: 2,                    // sealed AFTER the reset
      thread_local_seq: 1,
      preset: 'universal',
      content_md: '## TL;DR\nDone.\n',
      created_at: '2026-04-26T11:00:00Z',
    });

    // Force handler into the DB fallback path: reach getSnapshotPrefix on a
    // thread whose in-memory walk produces no result (fresh session = one
    // open segment, snapshotId null AND endedAt null = continue, not stop).
    const prefix = handler.getSnapshotPrefix(threadId);
    expect(prefix).toBeNull();
  });

  it('DB fallback: reset alone (no artifact after) still returns the reset summary', () => {
    // Sanity: the DB-fallback fix must NOT break the existing post-restart
    // path when there's no artifact later than the reset.
    const bus = new EventBus();
    const workers = [makeWorker('agent-a', 'Agent A')];
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const resetSnapshotDB = new ResetSnapshotDB(':memory:');
    const artifactDB = new ArtifactDB(':memory:');
    const handler = new DeliberationHandler(bus, workers, minConfig, sendFn, {
      resetSnapshotDB,
      artifactDB,
    });

    const threadId = 4;

    resetSnapshotDB.recordSnapshot({
      snapshotId: 'reset-r1',
      threadId,
      segmentIndex: 1,
      sealedAt: '2026-04-26T10:00:00Z',
      summaryMarkdown: 'EXPECTED CARRY-FORWARD SUMMARY',
      metadata: { openQuestionsCount: 0, decisionsCount: 0, blindReviewSessionId: null },
    });
    // No artifact rows for this thread.

    const prefix = handler.getSnapshotPrefix(threadId);
    expect(prefix).toBe('EXPECTED CARRY-FORWARD SUMMARY');
  });
});
