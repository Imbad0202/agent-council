import type { ResetSnapshotDB } from '../storage/reset-snapshot-db.js';
import type { ArtifactDB } from './artifact-db.js';

interface HandlerForCounter {
  getSegments(threadId: number): readonly { snapshotId: string | null }[];
}

/**
 * Cross-table seal-counter formula. Single source of truth used by BOTH
 * /councildone (ArtifactService) and /councilreset (SessionReset) so the
 * counter stays monotonic across process restarts.
 *
 * Spec §4: nextSegmentIndex = max(reset_snapshots ∪ council_artifacts) + 1
 *                          OR handler.getSegments(threadId).length - 1
 */
export function computeNextSegmentIndex(
  threadId: number,
  resetDb: ResetSnapshotDB,
  artifactDb: ArtifactDB,
  handler: HandlerForCounter,
): number {
  const resetIdx = resetDb.listSnapshotsForThread(threadId).map(s => s.segmentIndex);
  const artIdx = artifactDb.findByThread(threadId).map(r => r.segment_index);
  const all = [...resetIdx, ...artIdx];
  if (all.length > 0) return Math.max(...all) + 1;
  return handler.getSegments(threadId).length - 1;
}
