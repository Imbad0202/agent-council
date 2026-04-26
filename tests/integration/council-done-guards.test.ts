/**
 * Integration tests for /councildone mutual-exclusion guards (spec §11 invariant 11).
 *
 * These tests verify:
 *   11a. /councilreset refuses while /councildone synthesis is in flight.
 *   11b. /councildone refuses while /councilreset is in flight.
 *   11c. /councilshow cross-thread isolation (no leak between threads).
 *   11d. Missing synthesizerConfig throws immediately without startup crash.
 *
 * Uses REAL DeliberationHandler + REAL DBs (:memory:) + stub providers.
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
import {
  buildArtifactBundle,
  buildRealHandler,
  makeStubProvider,
  SYNTH_AGENT_CONFIG,
  DEFAULT_ARTIFACT_BODY,
} from '../helpers/deliberation-factory.js';
import { makeMessage } from '../council/helpers.js';
import { createProvider } from '../../src/worker/providers/factory.js';
import { ArtifactService } from '../../src/council/artifact-service.js';
import { ArtifactDB } from '../../src/council/artifact-db.js';
import { SynthesisInProgressError } from '../../src/council/session-reset-errors.js';
import {
  ArtifactResetInFlightError,
  MissingSynthesizerConfigError,
} from '../../src/council/artifact-errors.js';

const THREAD = 42;
const THREAD_B = 99;

async function runOneRound(
  bus: ReturnType<typeof buildArtifactBundle>['bus'],
  content: string,
  threadId: number = THREAD,
): Promise<void> {
  const done = new Promise<void>((resolve) => {
    bus.on('deliberation.ended', () => resolve());
  });
  bus.emit('intent.classified', {
    intent: 'deliberation',
    complexity: 'medium',
    threadId,
    message: makeMessage(content, threadId),
  });
  await done;
}

describe('/councildone guards — spec §11 invariant 11', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 11a. /councilreset refuses while /councildone synthesis is in flight ─────

  it('spec §11 invariant 11a: /councilreset throws SynthesisInProgressError while synthesize() is in flight', async () => {
    // Build a hanging provider: synthesize() will never resolve until we unblock it.
    let unblockSynth!: () => void;
    const hangingProvider = makeStubProvider('mock-synth', DEFAULT_ARTIFACT_BODY);
    vi.spyOn(hangingProvider.provider, 'chat').mockImplementation(
      () =>
        new Promise<never>((resolve) => {
          unblockSynth = () =>
            resolve({
              content: DEFAULT_ARTIFACT_BODY,
              tokensUsed: { input: 5, output: 50 },
            } as never);
        }),
    );

    vi.mocked(createProvider).mockReturnValue(hangingProvider.provider);

    const bundle = buildArtifactBundle();
    const { artifactService, bus, handler, sessionReset } = bundle;

    // Seed a deliberation round so the segment is non-empty.
    await runOneRound(bus, 'seed message for guard test');

    // Start synthesize() — it will hang on the provider call.
    const synthPromise = artifactService.synthesize(THREAD, 'universal');

    // Give the event loop one tick so synthesize() sets synthesisInFlight=true
    // before we test the guard. The hanging provider means it never resolves
    // past the LLM call, so synthesisInFlight stays true.
    await new Promise<void>((r) => setTimeout(r, 0));

    // /councilreset must refuse with SynthesisInProgressError.
    await expect(sessionReset.reset(handler as never, THREAD)).rejects.toThrow(
      SynthesisInProgressError,
    );

    // Unblock the synthesis so the test can clean up.
    unblockSynth();
    await synthPromise;
  });

  // ── 11b. /councildone refuses while resetInFlight is true ───────────────────

  it('spec §11 invariant 11b: synthesize() throws ArtifactResetInFlightError while resetInFlight is true on the handler', async () => {
    const bundle = buildArtifactBundle();
    vi.mocked(createProvider).mockReturnValue(bundle.synthProvider.provider);

    const { artifactService, bus, handler } = bundle;

    await runOneRound(bus, 'seed message for reset-in-flight guard');

    // Manually set the resetInFlight flag (mirrors what SessionReset.reset does
    // before the facilitator call).
    handler.setResetInFlight(THREAD, true);

    await expect(artifactService.synthesize(THREAD, 'universal')).rejects.toThrow(
      ArtifactResetInFlightError,
    );

    // Clean up the flag so subsequent tests are unaffected.
    handler.setResetInFlight(THREAD, false);
  });

  // ── 11c. /councilshow cross-thread isolation ─────────────────────────────────

  it('spec §11 invariant 11c: artifact inserted for thread A is not returned when querying from thread B', async () => {
    const bundle = buildArtifactBundle();
    vi.mocked(createProvider).mockReturnValue(bundle.synthProvider.provider);

    const { artifactDb } = bundle;

    // Directly insert an artifact row for THREAD.
    const inserted = artifactDb.insert({
      thread_id: THREAD,
      segment_index: 0,
      thread_local_seq: 1,
      preset: 'universal',
      content_md: DEFAULT_ARTIFACT_BODY,
      created_at: new Date().toISOString(),
    });

    // Query for THREAD returns the artifact.
    const found = artifactDb.findByThreadPreset(THREAD, 'universal');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(inserted.id);

    // Query for THREAD_B returns null — no cross-thread leak.
    const notFound = artifactDb.findByThreadPreset(THREAD_B, 'universal');
    expect(notFound).toBeNull();
  });

  // ── 11d. Missing synthesizerConfig throws immediately ───────────────────────

  it('spec §11 invariant 11d: synthesize() throws MissingSynthesizerConfigError immediately when synthesizerConfig is null', async () => {
    const base = buildRealHandler();

    // Wire an ArtifactService with no synthesizerConfig.
    const artifactDb = new ArtifactDB(':memory:');
    const svc = new ArtifactService({
      synthesizerConfig: null,
      artifactDb,
      resetDb: base.db,
      handler: base.handler,
      bus: base.bus,
    });

    // synthesize() must throw before touching the provider factory.
    await expect(svc.synthesize(THREAD, 'universal')).rejects.toThrow(
      MissingSynthesizerConfigError,
    );

    // Provider factory was never called.
    expect(vi.mocked(createProvider)).not.toHaveBeenCalled();
  });
});
