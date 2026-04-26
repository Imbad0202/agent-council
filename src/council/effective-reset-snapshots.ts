import type { ResetSnapshotDB } from '../storage/reset-snapshot-db.js';
import type { ArtifactDB } from './artifact-db.js';
import type { ResetSnapshot } from '../types.js';

/**
 * Cross-cutting artifact-boundary filter for reset snapshots.
 *
 * Spec §0 designates `/councildone` as a closing primitive: older context
 * (reset summaries from before an artifact seal) must NOT leak into
 * subsequent deliberations or `/councilreset` prior-summary blocks. Without
 * this filter, every historical-context call site would have to re-implement
 * the same artifact-boundary check, which is whack-a-mole maintenance and
 * a known failure mode (codex review rounds 4-5 caught two separate
 * surfaces missing the filter).
 *
 * Returns the subset of reset snapshots that come AFTER the latest artifact
 * seal for the thread. If no artifact exists, returns all snapshots.
 *
 * If `artifactDb` is undefined (legacy DeliberationHandler / pre-v0.5.2.a
 * test fixtures), returns all snapshots — preserves backwards-compat. The
 * production wiring in `src/index.ts` always provides `artifactDb`, so the
 * filter applies in real deployments.
 *
 * Caveats:
 *   - The "artifact boundary" is defined by `segment_index`. Snapshots with
 *     `segmentIndex > latestArtifactIdx` are kept. Equality (an artifact
 *     and a reset at the SAME segment index) is impossible by spec §4
 *     UNIQUE(thread_id, segment_index) constraint, but the strict-greater
 *     comparison handles it deterministically anyway.
 *   - Returns the snapshots in the same order as the DB layer (segment_index
 *     ASC per `listSnapshotsForThread`). Callers that expected most-recent-
 *     first should reverse explicitly.
 */
export function effectiveResetSnapshots(
  threadId: number,
  resetDb: ResetSnapshotDB,
  artifactDb: ArtifactDB | undefined,
): ResetSnapshot[] {
  const all = resetDb.listSnapshotsForThread(threadId);
  if (!artifactDb) return all;
  const artifactIndices = artifactDb.findByThread(threadId).map(r => r.segment_index);
  if (artifactIndices.length === 0) return all;
  const latestArtifactIdx = Math.max(...artifactIndices);
  return all.filter(s => s.segmentIndex > latestArtifactIdx);
}
