import { describe, it, expect, beforeEach } from 'vitest';
import { ArtifactDB } from '../../src/council/artifact-db.js';
import { ResetSnapshotDB } from '../../src/storage/reset-snapshot-db.js';
import { ArtifactService } from '../../src/council/artifact-service.js';
import type { HandlerForArtifact } from '../../src/council/artifact-service.js';
import { EventBus } from '../../src/events/bus.js';
import type { AgentConfig } from '../../src/types.js';
import {
  MissingSynthesizerConfigError,
  ArtifactResetInFlightError,
  ArtifactDeliberationInFlightError,
  PendingClassificationError,
  ArtifactBlindReviewActiveError,
  ArtifactEmptySegmentError,
  SynthesisAlreadyRunningError,
} from '../../src/council/artifact-errors.js';

// ─── Mock handler ───────────────────────────────────────────────────────────

interface MockHandlerState {
  segments: { snapshotId: string | null; messages: { id: string }[] }[];
  resetInFlight: boolean;
  deliberationInFlight: boolean;
  pendingClassifications: boolean;
  blindReviewSessionId: string | null;
  synthesisInFlight: boolean;
}

function makeHandler(over: Partial<MockHandlerState> = {}): HandlerForArtifact {
  const state: MockHandlerState = {
    segments: [{ snapshotId: null, messages: [] }],
    resetInFlight: false,
    deliberationInFlight: false,
    pendingClassifications: false,
    blindReviewSessionId: null,
    synthesisInFlight: false,
    ...over,
  };

  return {
    isResetInFlight: (_threadId: number) => state.resetInFlight,
    isDeliberationInFlight: (_threadId: number) => state.deliberationInFlight,
    hasPendingClassifications: (_threadId: number) => state.pendingClassifications,
    getBlindReviewSessionId: (_threadId: number) => state.blindReviewSessionId,
    getCurrentSegment: (_threadId: number) => state.segments[state.segments.length - 1],
    getSegments: (_threadId: number) => state.segments.map(s => ({ snapshotId: s.snapshotId })),
    isSynthesisInFlight: (_threadId: number) => state.synthesisInFlight,
    setSynthesisInFlight: (_threadId: number, _v: boolean) => { state.synthesisInFlight = _v; },
    sealCurrentSegment: (_threadId: number, _id: string | null) => {},
    unsealCurrentSegment: (_threadId: number) => {},
    openNewSegment: (_threadId: number) => {},
  };
}

// ─── Fixture config ──────────────────────────────────────────────────────────

const SYNTH_CONFIG: AgentConfig = {
  id: 'synth-1',
  name: 'Synthesizer',
  provider: 'claude',
  model: 'claude-3-5-sonnet-20241022',
  memoryDir: '/tmp/synth-mem',
  personality: 'concise artifact synthesizer',
  roleType: 'artifact-synthesizer',
};

// ─── Helper factory ──────────────────────────────────────────────────────────

function makeService(opts: {
  synthesizerConfig?: AgentConfig | null;
  handler?: HandlerForArtifact;
  artifactDb?: ArtifactDB;
  resetDb?: ResetSnapshotDB;
}): ArtifactService {
  return new ArtifactService({
    synthesizerConfig: opts.synthesizerConfig !== undefined ? opts.synthesizerConfig : SYNTH_CONFIG,
    artifactDb: opts.artifactDb ?? new ArtifactDB(':memory:'),
    resetDb: opts.resetDb ?? new ResetSnapshotDB(':memory:'),
    handler: opts.handler ?? makeHandler(),
    bus: new EventBus(),
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ArtifactService Phase 1 — pre-checks', () => {
  const THREAD = 42;

  describe('MissingSynthesizerConfigError — FIRST guard', () => {
    it('throws MissingSynthesizerConfigError when synthesizerConfig is null', async () => {
      // All other guards would also fire (resetInFlight, blindReview) — missing-config wins.
      const svc = makeService({
        synthesizerConfig: null,
        handler: makeHandler({
          resetInFlight: true,
          blindReviewSessionId: 'br-session-x',
        }),
      });
      await expect(svc.synthesize(THREAD, 'universal')).rejects.toThrow(MissingSynthesizerConfigError);
    });

    it('does NOT throw MissingSynthesizerConfigError when config is present', async () => {
      // Config present but reset in flight → should throw reset error (not config error).
      const svc = makeService({
        synthesizerConfig: SYNTH_CONFIG,
        handler: makeHandler({ resetInFlight: true }),
      });
      await expect(svc.synthesize(THREAD, 'universal')).rejects.toThrow(ArtifactResetInFlightError);
    });
  });

  describe('Transient lock guards', () => {
    it('throws ArtifactResetInFlightError when reset is in flight', async () => {
      const svc = makeService({ handler: makeHandler({ resetInFlight: true }) });
      await expect(svc.synthesize(THREAD, 'universal')).rejects.toThrow(ArtifactResetInFlightError);
    });

    it('ArtifactResetInFlightError carries threadId', async () => {
      const svc = makeService({ handler: makeHandler({ resetInFlight: true }) });
      await expect(svc.synthesize(THREAD, 'universal')).rejects.toMatchObject({ threadId: THREAD });
    });

    it('throws ArtifactDeliberationInFlightError when deliberation is in flight', async () => {
      const svc = makeService({ handler: makeHandler({ deliberationInFlight: true }) });
      await expect(svc.synthesize(THREAD, 'universal')).rejects.toThrow(ArtifactDeliberationInFlightError);
    });

    it('ArtifactDeliberationInFlightError carries threadId', async () => {
      const svc = makeService({ handler: makeHandler({ deliberationInFlight: true }) });
      await expect(svc.synthesize(THREAD, 'universal')).rejects.toMatchObject({ threadId: THREAD });
    });

    it('throws PendingClassificationError when classifications are pending', async () => {
      const svc = makeService({ handler: makeHandler({ pendingClassifications: true }) });
      await expect(svc.synthesize(THREAD, 'universal')).rejects.toThrow(PendingClassificationError);
    });

    it('PendingClassificationError carries threadId', async () => {
      const svc = makeService({ handler: makeHandler({ pendingClassifications: true }) });
      await expect(svc.synthesize(THREAD, 'universal')).rejects.toMatchObject({ threadId: THREAD });
    });

    it('reset guard fires before deliberation guard when both in flight', async () => {
      const svc = makeService({
        handler: makeHandler({ resetInFlight: true, deliberationInFlight: true }),
      });
      await expect(svc.synthesize(THREAD, 'universal')).rejects.toThrow(ArtifactResetInFlightError);
    });

    it('deliberation guard fires before pendingClassifications guard when both in flight', async () => {
      const svc = makeService({
        handler: makeHandler({ deliberationInFlight: true, pendingClassifications: true }),
      });
      await expect(svc.synthesize(THREAD, 'universal')).rejects.toThrow(ArtifactDeliberationInFlightError);
    });
  });

  describe('Persistent guard — blind review', () => {
    it('throws ArtifactBlindReviewActiveError when blind-review session is active', async () => {
      const svc = makeService({ handler: makeHandler({ blindReviewSessionId: 'session-abc' }) });
      await expect(svc.synthesize(THREAD, 'universal')).rejects.toThrow(ArtifactBlindReviewActiveError);
    });

    it('ArtifactBlindReviewActiveError carries threadId', async () => {
      const svc = makeService({ handler: makeHandler({ blindReviewSessionId: 'session-abc' }) });
      await expect(svc.synthesize(THREAD, 'universal')).rejects.toMatchObject({ threadId: THREAD });
    });
  });

  describe('ArtifactEmptySegmentError', () => {
    it('throws ArtifactEmptySegmentError when current segment is empty and no cached row exists', async () => {
      // All guards pass, no cache, no messages → empty segment error.
      const svc = makeService({ handler: makeHandler({ segments: [{ snapshotId: null, messages: [] }] }) });
      await expect(svc.synthesize(THREAD, 'universal')).rejects.toThrow(ArtifactEmptySegmentError);
    });
  });

  describe('SynthesisAlreadyRunningError', () => {
    it('throws SynthesisAlreadyRunningError when synthesis is already in flight', async () => {
      // Current segment has messages (so empty-segment guard doesn't fire) but synthesis is running.
      const svc = makeService({
        handler: makeHandler({
          segments: [{ snapshotId: null, messages: [{ id: 'msg-1' }] }],
          synthesisInFlight: true,
        }),
      });
      await expect(svc.synthesize(THREAD, 'universal')).rejects.toThrow(SynthesisAlreadyRunningError);
    });

    it('SynthesisAlreadyRunningError carries threadId', async () => {
      const svc = makeService({
        handler: makeHandler({
          segments: [{ snapshotId: null, messages: [{ id: 'msg-1' }] }],
          synthesisInFlight: true,
        }),
      });
      await expect(svc.synthesize(THREAD, 'universal')).rejects.toMatchObject({ threadId: THREAD });
    });
  });

  describe('Fast-path: cached row returned when stale segment + no new messages', () => {
    it('returns cached ArtifactRow when all three fast-path conditions are met', async () => {
      const artifactDb = new ArtifactDB(':memory:');
      const resetDb = new ResetSnapshotDB(':memory:');

      // Insert a cached row at segment_index 0.
      const cached = artifactDb.insert({
        thread_id: THREAD,
        segment_index: 0,
        thread_local_seq: 1,
        preset: 'universal',
        content_md: '## TL;DR\ncached summary',
        created_at: '2026-04-26T00:00:00Z',
      });

      // Record a reset snapshot at segment_index 0 so lastSealedSegmentIndex returns 0.
      resetDb.recordSnapshot({
        snapshotId: 'snap-1',
        threadId: THREAD,
        segmentIndex: 0,
        sealedAt: '2026-04-26T00:00:00Z',
        summaryMarkdown: 'prior summary',
        metadata: { openQuestionsCount: 0, decisionsCount: 0, blindReviewSessionId: null },
      });

      // Current segment is empty — fast-path should return cached row without calling Phase 2.
      const svc = makeService({
        artifactDb,
        resetDb,
        handler: makeHandler({ segments: [{ snapshotId: 'snap-1', messages: [] }] }),
      });

      const result = await svc.synthesize(THREAD, 'universal');
      expect(result).toEqual(cached);
    });

    it('does NOT return cached when currentSegment has new messages (cache is stale)', async () => {
      const artifactDb = new ArtifactDB(':memory:');
      const resetDb = new ResetSnapshotDB(':memory:');

      artifactDb.insert({
        thread_id: THREAD,
        segment_index: 0,
        thread_local_seq: 1,
        preset: 'universal',
        content_md: '## TL;DR\ncached summary',
        created_at: '2026-04-26T00:00:00Z',
      });

      resetDb.recordSnapshot({
        snapshotId: 'snap-1',
        threadId: THREAD,
        segmentIndex: 0,
        sealedAt: '2026-04-26T00:00:00Z',
        summaryMarkdown: 'prior summary',
        metadata: { openQuestionsCount: 0, decisionsCount: 0, blindReviewSessionId: null },
      });

      // Current segment has a message → cache is stale, fast-path should NOT trigger.
      // Empty-segment guard also won't fire because messages.length > 0.
      // synthesisInFlight = false → Phase 2/3 runs (provider call expected but will throw
      // due to missing API key in test environment — the important thing is that the
      // cached row is NOT returned directly).
      const svc = makeService({
        artifactDb,
        resetDb,
        handler: makeHandler({
          segments: [{ snapshotId: 'snap-1', messages: [{ id: 'msg-new' }] }],
        }),
      });

      // Phase 2/3 is now implemented; it will attempt to call the provider and throw
      // (no API key in test env) — not return the stale cached row.
      await expect(svc.synthesize(THREAD, 'universal')).rejects.toThrow();
    });

    it('does NOT return cached when cached.segment_index does not match lastSealedSegmentIndex', async () => {
      const artifactDb = new ArtifactDB(':memory:');
      const resetDb = new ResetSnapshotDB(':memory:');

      // Cached row at segment_index 0, but lastSealed is 1 (a newer segment was sealed).
      artifactDb.insert({
        thread_id: THREAD,
        segment_index: 0,
        thread_local_seq: 1,
        preset: 'universal',
        content_md: '## TL;DR\nold summary',
        created_at: '2026-04-26T00:00:00Z',
      });

      resetDb.recordSnapshot({
        snapshotId: 'snap-2',
        threadId: THREAD,
        segmentIndex: 1,
        sealedAt: '2026-04-26T01:00:00Z',
        summaryMarkdown: 'newer summary',
        metadata: { openQuestionsCount: 0, decisionsCount: 0, blindReviewSessionId: null },
      });

      // Current segment is empty — but cached.segment_index(0) !== lastSealedIdx(1).
      const svc = makeService({
        artifactDb,
        resetDb,
        handler: makeHandler({ segments: [{ snapshotId: 'snap-2', messages: [] }] }),
      });

      // Fast-path is bypassed; currentSegment has no messages → ArtifactEmptySegmentError.
      await expect(svc.synthesize(THREAD, 'universal')).rejects.toThrow(ArtifactEmptySegmentError);
    });
  });

  describe('lastSealedSegmentIndex helper', () => {
    it('returns null when neither resetDb nor artifactDb has rows', () => {
      const svc = makeService({});
      expect(svc.lastSealedSegmentIndex(THREAD)).toBeNull();
    });

    it('returns the max segment_index from artifactDb rows', () => {
      const artifactDb = new ArtifactDB(':memory:');
      artifactDb.insert({ thread_id: THREAD, segment_index: 2, thread_local_seq: 1, preset: 'universal', content_md: 'a', created_at: '2026-04-26T00:00:00Z' });
      artifactDb.insert({ thread_id: THREAD, segment_index: 5, thread_local_seq: 2, preset: 'decision', content_md: 'b', created_at: '2026-04-26T00:00:00Z' });
      const svc = makeService({ artifactDb });
      expect(svc.lastSealedSegmentIndex(THREAD)).toBe(5);
    });

    it('returns the max segment_index from resetDb rows', () => {
      const resetDb = new ResetSnapshotDB(':memory:');
      resetDb.recordSnapshot({ snapshotId: 'x', threadId: THREAD, segmentIndex: 3, sealedAt: '2026-04-26T00:00:00Z', summaryMarkdown: 's', metadata: { openQuestionsCount: 0, decisionsCount: 0, blindReviewSessionId: null } });
      const svc = makeService({ resetDb });
      expect(svc.lastSealedSegmentIndex(THREAD)).toBe(3);
    });

    it('returns the cross-table max when both tables have rows', () => {
      const artifactDb = new ArtifactDB(':memory:');
      const resetDb = new ResetSnapshotDB(':memory:');
      artifactDb.insert({ thread_id: THREAD, segment_index: 2, thread_local_seq: 1, preset: 'universal', content_md: 'a', created_at: '2026-04-26T00:00:00Z' });
      resetDb.recordSnapshot({ snapshotId: 'y', threadId: THREAD, segmentIndex: 7, sealedAt: '2026-04-26T00:00:00Z', summaryMarkdown: 's', metadata: { openQuestionsCount: 0, decisionsCount: 0, blindReviewSessionId: null } });
      const svc = makeService({ artifactDb, resetDb });
      expect(svc.lastSealedSegmentIndex(THREAD)).toBe(7);
    });
  });

  // Phase 2/3 stub describe block removed in Task 12 — synthesis is now implemented.
  // Coverage of the full synthesis pipeline lives in artifact-service-synthesis.test.ts.
});
