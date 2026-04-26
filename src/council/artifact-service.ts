import type { AgentConfig, CouncilMessage } from '../types.js';
import type { EventBus } from '../events/bus.js';
import type { ResetSnapshotDB } from '../storage/reset-snapshot-db.js';
import { ArtifactDB, type ArtifactRow } from './artifact-db.js';
import {
  MissingSynthesizerConfigError,
  MalformedArtifactError,
  ArtifactResetInFlightError,
  ArtifactDeliberationInFlightError,
  PendingClassificationError,
  ArtifactBlindReviewActiveError,
  ArtifactEmptySegmentError,
  SynthesisAlreadyRunningError,
} from './artifact-errors.js';
import { type Preset, buildArtifactPrompt, parseArtifact } from './artifact-prompt.js';
import { computeNextSegmentIndex } from './segment-counter.js';
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

    // === Phase 2: synthesis (no segment mutation) ===
    this.deps.handler.setSynthesisInFlight(threadId, true);
    try {
      const provider = createProvider(this.deps.synthesizerConfig.provider);
      const { messages, options } = buildArtifactPrompt(
        preset,
        currentSegment.messages,
        this.deps.synthesizerConfig.model,
      );
      const response = await invokeWithRetry(provider, messages, options);

      const parsed = parseArtifact(response.content);
      if (!parsed.tldr) throw new MalformedArtifactError(response.content);

      // === Phase 3: commit ===
      const newSegmentIndex = computeNextSegmentIndex(
        threadId, this.deps.resetDb, this.deps.artifactDb, this.deps.handler,
      );
      const newSeq = (this.deps.artifactDb.maxThreadLocalSeq(threadId) ?? 0) + 1;

      this.deps.handler.sealCurrentSegment(threadId, null);

      let inserted: ArtifactRow;
      try {
        inserted = this.deps.artifactDb.insert({
          thread_id: threadId,
          segment_index: newSegmentIndex,
          thread_local_seq: newSeq,
          preset,
          content_md: response.content,
          created_at: new Date().toISOString(),
          synthesis_model: response.modelUsed ?? options.model,
          synthesis_token_usage_json: JSON.stringify(response.tokensUsed),
        });
      } catch (insertErr) {
        this.deps.handler.unsealCurrentSegment(threadId);
        throw insertErr;
      }

      try {
        this.deps.handler.openNewSegment(threadId);
      } catch (openErr) {
        // Best-effort rollback (round-8 P2-3): each step independently wrapped
        // so a failing deleteById does NOT skip the unseal (and vice versa).
        // The original openErr is rethrown after both cleanup attempts complete,
        // regardless of cleanup success.
        try { this.deps.artifactDb.deleteById(inserted.id); }
        catch (delErr) { console.error('[ArtifactService] rollback: deleteById failed after openNewSegment failure', delErr); }
        try { this.deps.handler.unsealCurrentSegment(threadId); }
        catch (unsealErr) { console.error('[ArtifactService] rollback: unsealCurrentSegment failed after openNewSegment failure', unsealErr); }
        throw openErr;
      }

      this.deps.bus.emit('artifact.created', {
        threadId,
        segmentIndex: newSegmentIndex,
        threadLocalSeq: newSeq,
        preset,
      });

      return inserted;
    } finally {
      this.deps.handler.setSynthesisInFlight(threadId, false);
    }
  }

  fetchByThreadLocalSeq(threadId: number, seq: number): ArtifactRow | null {
    return this.deps.artifactDb.fetchByThreadLocalSeq(threadId, seq);
  }
}
