/**
 * Integration tests for /councildone happy path + cache-invalidation invariants.
 *
 * These tests use REAL DeliberationHandler + REAL DBs (:memory:) + stub providers
 * (vi.fn), promoting the unit-level spec §11 invariants 5 and 5b into full
 * end-to-end scope.
 *
 * vi.mock must be declared at file top — vitest hoists it before imports.
 */

// ---------------------------------------------------------------------------
// Mock the provider factory so ArtifactService never calls a real LLM.
// ---------------------------------------------------------------------------
vi.mock('../../src/worker/providers/factory.js', () => ({
  createProvider: vi.fn(),
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildArtifactBundle, DEFAULT_ARTIFACT_BODY } from '../helpers/deliberation-factory.js';
import { makeMessage } from '../council/helpers.js';
import { createProvider } from '../../src/worker/providers/factory.js';

const THREAD = 42;

async function runOneRound(
  bus: ReturnType<typeof buildArtifactBundle>['bus'],
  content: string,
): Promise<void> {
  const done = new Promise<void>((resolve) => {
    bus.on('deliberation.ended', () => resolve());
  });
  bus.emit('intent.classified', {
    intent: 'deliberation',
    complexity: 'medium',
    threadId: THREAD,
    message: makeMessage(content, THREAD),
  });
  await done;
}

describe('/councildone flow — happy path + cache invariants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 1. End-to-end happy path ────────────────────────────────────────────────

  it('synthesize returns a valid ArtifactRow, inserts DB row, seals + opens segment, emits artifact.created, clears synthesisInFlight', async () => {
    const bundle = buildArtifactBundle();
    vi.mocked(createProvider).mockReturnValue(bundle.synthProvider.provider);

    const { artifactService, artifactDb, bus, handler } = bundle;

    // Seed one deliberation round so the current segment has messages.
    await runOneRound(bus, 'should we use rust or go for the data plane?');

    const rowsBefore = artifactDb.findByThread(THREAD).length;
    const segsBefore = handler.getSegments(THREAD).length;

    const emittedEvents: unknown[] = [];
    bus.on('artifact.created', (payload) => emittedEvents.push(payload));

    const result = await artifactService.synthesize(THREAD, 'universal');

    // Returns a valid ArtifactRow with TL;DR content.
    expect(result.thread_id).toBe(THREAD);
    expect(result.preset).toBe('universal');
    expect(result.content_md).toBe(DEFAULT_ARTIFACT_BODY);
    expect(result.content_md).toContain('## TL;DR');
    expect(result.segment_index).toBeGreaterThanOrEqual(0);
    expect(result.thread_local_seq).toBeGreaterThanOrEqual(1);

    // DB row count grew by 1.
    expect(artifactDb.findByThread(THREAD).length).toBe(rowsBefore + 1);

    // Segment count grew by 1 (old segment sealed + new one opened).
    expect(handler.getSegments(THREAD).length).toBe(segsBefore + 1);

    // New segment is open (endedAt === null).
    const segs = handler.getSegments(THREAD);
    expect(segs[segs.length - 1].snapshotId).toBeNull();

    // artifact.created event was emitted.
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toMatchObject({
      threadId: THREAD,
      preset: 'universal',
    });

    // synthesisInFlight cleared.
    expect(handler.isSynthesisInFlight(THREAD)).toBe(false);
  });

  // ── 2. Spec invariant 5b — cache invalidation after reset between done calls ─

  it('spec §11 invariant 5b: /councildone after /councilreset produces NEW artifact for the new segment, not the cached one', async () => {
    const bundle = buildArtifactBundle();
    vi.mocked(createProvider).mockReturnValue(bundle.synthProvider.provider);

    const { artifactService, artifactDb, bus, handler, sessionReset } = bundle;

    // Segment 0: push 3 rounds.
    await runOneRound(bus, 'message one for segment 0');
    await runOneRound(bus, 'message two for segment 0');
    await runOneRound(bus, 'message three for segment 0');

    // /councildone → artifact #1 on segment 0.
    const artifact1 = await artifactService.synthesize(THREAD, 'universal');
    // Spec §11 5b: the FIRST artifact pins to segment_index 0 (no prior seals
    // in either reset_snapshots or council_artifacts). Exact equality matters
    // because the next assertion below derives from this baseline.
    expect(artifact1.segment_index).toBe(0);
    const firstCallCount = vi.mocked(bundle.synthProvider.provider.chat).mock.calls.length;

    // Segment 1: push 1 message.
    await runOneRound(bus, 'message one for segment 1');

    // /councilreset → seals segment 1 into session_reset_snapshots.
    await sessionReset.reset(handler as never, THREAD);

    // Segment 2: push 1 message.
    await runOneRound(bus, 'message one for segment 2');

    // /councildone again — must NOT return cached artifact from segment 0.
    const artifact2 = await artifactService.synthesize(THREAD, 'universal');

    // Spec §11 5b: cross-table monotonic counter. The second /councildone
    // must read BOTH the artifact table ([0]) AND the reset_snapshots table
    // ([1]) and produce max + 1 = 2. Asserting exact equality (not >) catches
    // future drift in computeNextSegmentIndex — e.g. if the reset path
    // regressed to segments.length-1, segment_index could come out 1 instead
    // of 2 and a `>` test would still pass.
    expect(artifact2.segment_index).toBe(2);

    // Provider was called again (not cached).
    const secondCallCount = vi.mocked(bundle.synthProvider.provider.chat).mock.calls.length;
    expect(secondCallCount).toBeGreaterThan(firstCallCount);

    // Two distinct DB rows for this thread now.
    const allRows = artifactDb.findByThread(THREAD);
    expect(allRows.length).toBe(2);
    expect(allRows[0].segment_index).not.toBe(allRows[1].segment_index);
  });

  // ── 3. Spec invariant 5 — idempotent /councildone returns cached row ─────────

  it('spec §11 invariant 5: calling /councildone twice without new messages returns the SAME cached artifact and calls provider only once', async () => {
    const bundle = buildArtifactBundle();
    vi.mocked(createProvider).mockReturnValue(bundle.synthProvider.provider);

    const { artifactService, bus } = bundle;

    // Seed 2 rounds of deliberation.
    await runOneRound(bus, 'first message');
    await runOneRound(bus, 'second message');

    // First /councildone → synthesizes + seals.
    const artifact1 = await artifactService.synthesize(THREAD, 'universal');
    const callsAfterFirst = vi.mocked(bundle.synthProvider.provider.chat).mock.calls.length;

    // Spec §11 invariant 5: the first synthesis is exactly ONE provider
    // invocation. Asserting only "second call adds zero" would mask a
    // regression where invokeWithRetry silently retried a transient failure
    // (callsAfterFirst could become 2, and `secondCount === firstCount`
    // would still pass). Exact equality pins the spec contract.
    expect(callsAfterFirst).toBe(1);

    // Second /councildone — no new messages since the last seal.
    const artifact2 = await artifactService.synthesize(THREAD, 'universal');
    const callsAfterSecond = vi.mocked(bundle.synthProvider.provider.chat).mock.calls.length;

    // SAME artifact returned (same DB id).
    expect(artifact2.id).toBe(artifact1.id);
    expect(artifact2.segment_index).toBe(artifact1.segment_index);
    expect(artifact2.content_md).toBe(artifact1.content_md);

    // Provider was NOT called a second time — pure cache hit.
    expect(callsAfterSecond).toBe(callsAfterFirst);
  });
});
