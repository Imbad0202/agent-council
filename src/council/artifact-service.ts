import type { AgentConfig, CouncilMessage } from '../types.js';
import type { EventBus } from '../events/bus.js';
import type { ResetSnapshotDB } from '../storage/reset-snapshot-db.js';
import { ArtifactDB, type ArtifactRow } from './artifact-db.js';
import {
  MissingSynthesizerConfigError,
  ArtifactResetInFlightError,
  ArtifactDeliberationInFlightError,
  PendingClassificationError,
  ArtifactBlindReviewActiveError,
  ArtifactEmptySegmentError,
  SynthesisAlreadyRunningError,
} from './artifact-errors.js';
import { type Preset } from './artifact-prompt.js';

// Phase 2/3 forward-staged imports — used in Task 12 (synthesis + commit phases).
// Kept here so the Task 12 implementer doesn't have to add them mid-feature;
// tsc passes today because tsconfig.json doesn't enable `noUnusedLocals`.
import { MalformedArtifactError } from './artifact-errors.js';
import { computeNextSegmentIndex } from './segment-counter.js';
import { buildArtifactPrompt, parseArtifact } from './artifact-prompt.js';
import { invokeWithRetry } from './artifact-invoke.js';
import { createProvider } from '../worker/providers/factory.js';

export interface HandlerForArtifact {
  isResetInFlight(threadId: number): boolean;
  isDeliberationInFlight(threadId: number): boolean;
  hasPendingClassifications(threadId: number): boolean;
  getBlindReviewSessionId(threadId: number): string | null;
  getCurrentSegment(threadId: number): { messages: readonly CouncilMessage[] };
  getSegments(threadId: number): readonly { snapshotId: string | null }[];
  isSynthesisInFlight(threadId: number): boolean;
  setSynthesisInFlight(threadId: number, value: boolean): void;
  sealCurrentSegment(threadId: number, snapshotId: string | null): void;
  unsealCurrentSegment(threadId: number): void;
  openNewSegment(threadId: number): void;
}

export interface ArtifactServiceDeps {
  synthesizerConfig: AgentConfig | null;
  artifactDb: ArtifactDB;
  resetDb: ResetSnapshotDB;
  handler: HandlerForArtifact;
  bus: EventBus;
}

export class ArtifactService {
  constructor(private deps: ArtifactServiceDeps) {}

  /**
   * Returns the highest segment_index that has been SEALED for this thread,
   * across BOTH `session_reset_snapshots` and `council_artifacts`.
   * Returns null when no sealed segments exist for the thread.
   *
   * Used as the cache-freshness comparand in /councildone fast-path:
   * a cached artifact is fresh only if `cached.segment_index ===
   * lastSealedSegmentIndex(threadId)`. Distinct from
   * `computeNextSegmentIndex` (segment-counter.ts), which returns the
   * NEXT index to assign (max + 1).
   */
  lastSealedSegmentIndex(threadId: number): number | null {
    const r = this.deps.resetDb.listSnapshotsForThread(threadId).map(s => s.segmentIndex);
    const a = this.deps.artifactDb.findByThread(threadId).map(x => x.segment_index);
    const all = [...r, ...a];
    if (all.length === 0) return null;
    return Math.max(...all);
  }

  async synthesize(threadId: number, preset: Preset): Promise<ArtifactRow> {
    // === Phase 1: pre-checks (no mutation) ===

    // FIRST: missing-config — fires even when other guards would also trigger.
    if (this.deps.synthesizerConfig === null) {
      throw new MissingSynthesizerConfigError();
    }

    // Transient locks.
    if (this.deps.handler.isResetInFlight(threadId)) throw new ArtifactResetInFlightError(threadId);
    if (this.deps.handler.isDeliberationInFlight(threadId)) throw new ArtifactDeliberationInFlightError(threadId);
    if (this.deps.handler.hasPendingClassifications(threadId)) throw new PendingClassificationError(threadId);
    // Persistent guard.
    if (this.deps.handler.getBlindReviewSessionId(threadId)) throw new ArtifactBlindReviewActiveError(threadId);

    const currentSegment = this.deps.handler.getCurrentSegment(threadId);

    // Fast-path (after guards, so messages.length === 0 is authoritative).
    const cached = this.deps.artifactDb.findByThreadPreset(threadId, preset);
    const lastSealedIdx = this.lastSealedSegmentIndex(threadId);
    if (
      cached &&
      lastSealedIdx !== null &&
      cached.segment_index === lastSealedIdx &&
      currentSegment.messages.length === 0
    ) {
      return cached;
    }

    if (currentSegment.messages.length === 0) throw new ArtifactEmptySegmentError();
    if (this.deps.handler.isSynthesisInFlight(threadId)) throw new SynthesisAlreadyRunningError(threadId);

    // Phase 2 + 3 are added in Task 12.
    throw new Error('Phase 2/3 not yet implemented (Task 12)');
  }

  fetchByThreadLocalSeq(threadId: number, seq: number): ArtifactRow | null {
    return this.deps.artifactDb.fetchByThreadLocalSeq(threadId, seq);
  }
}
