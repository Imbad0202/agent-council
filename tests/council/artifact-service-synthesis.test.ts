import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMProvider } from '../../src/types.js';
import type { HandlerForArtifact } from '../../src/council/artifact-service.js';
import type { AgentConfig } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Mock the provider factory so ArtifactService never calls a real LLM.
// vi.mock is hoisted above imports by vitest, so the mock is active when
// artifact-service.ts is first resolved.
// ---------------------------------------------------------------------------
vi.mock('../../src/worker/providers/factory.js', () => ({
  createProvider: vi.fn(),
}));

// Import factory module reference AFTER mock registration so we can configure
// the mock's return value per test.
const factoryModule = await import('../../src/worker/providers/factory.js');

// Import service + deps AFTER mock is set up.
const { ArtifactService } = await import('../../src/council/artifact-service.js');
const { ArtifactDB } = await import('../../src/council/artifact-db.js');
const { ResetSnapshotDB } = await import('../../src/storage/reset-snapshot-db.js');
const { EventBus } = await import('../../src/events/bus.js');
const { MalformedArtifactError } = await import('../../src/council/artifact-errors.js');

// ---------------------------------------------------------------------------
// Canned provider response with a valid artifact body
// ---------------------------------------------------------------------------
const ARTIFACT_BODY = [
  '## TL;DR',
  '',
  'We chose option Z over Y.',
  '',
  '## Discussion',
  '',
  'It was a thorough debate.',
  '',
  '## Open questions',
  '',
  'What about timing?',
  '',
  '## Suggested next step',
  '',
  'Ship it.',
].join('\n');

// ---------------------------------------------------------------------------
// Mock handler state
// ---------------------------------------------------------------------------
interface MockHandlerState {
  segments: { snapshotId: string | null; messages: { id: string; role: 'human'; content: string }[] }[];
  resetInFlight: boolean;
  deliberationInFlight: boolean;
  pendingClassifications: boolean;
  blindReviewSessionId: string | null;
  synthesisInFlight: boolean;
}

function makeHandler(over: Partial<MockHandlerState> = {}): HandlerForArtifact & { _state: MockHandlerState } {
  const state: MockHandlerState = {
    segments: [{ snapshotId: null, messages: [{ id: 'msg-1', role: 'human', content: 'Let us debate.' }] }],
    resetInFlight: false,
    deliberationInFlight: false,
    pendingClassifications: false,
    blindReviewSessionId: null,
    synthesisInFlight: false,
    ...over,
  };

  return {
    _state: state,
    isResetInFlight: (_threadId: number) => state.resetInFlight,
    isDeliberationInFlight: (_threadId: number) => state.deliberationInFlight,
    hasPendingClassifications: (_threadId: number) => state.pendingClassifications,
    getBlindReviewSessionId: (_threadId: number) => state.blindReviewSessionId,
    getCurrentSegment: (_threadId: number) => state.segments[state.segments.length - 1],
    getSegments: (_threadId: number) => state.segments.map(s => ({ snapshotId: s.snapshotId })),
    isSynthesisInFlight: (_threadId: number) => state.synthesisInFlight,
    setSynthesisInFlight: vi.fn((_threadId: number, v: boolean) => { state.synthesisInFlight = v; }),
    // sealCurrentSegment marks the current segment as sealed (sets snapshotId).
    sealCurrentSegment: vi.fn((_threadId: number, snapshotId: string | null) => {
      const seg = state.segments[state.segments.length - 1];
      (seg as typeof seg & { snapshotId: string | null }).snapshotId = snapshotId ?? 'sealed';
    }),
    // unsealCurrentSegment reverses the seal.
    unsealCurrentSegment: vi.fn((_threadId: number) => {
      const seg = state.segments[state.segments.length - 1];
      (seg as typeof seg & { snapshotId: string | null }).snapshotId = null;
    }),
    // openNewSegment pushes a fresh empty segment.
    openNewSegment: vi.fn((_threadId: number) => {
      state.segments.push({ snapshotId: null, messages: [] });
    }),
  };
}

// ---------------------------------------------------------------------------
// Fixture config + helpers
// ---------------------------------------------------------------------------

const SYNTH_CONFIG: AgentConfig = {
  id: 'synth-1',
  name: 'Synthesizer',
  provider: 'mock',
  model: 'mock-model-v1',
  memoryDir: '/tmp/synth-mem',
  personality: 'concise artifact synthesizer',
  roleType: 'artifact-synthesizer',
};

const THREAD = 42;

function makeService(opts: {
  handler: HandlerForArtifact & { _state: MockHandlerState };
  artifactDb?: InstanceType<typeof ArtifactDB>;
  resetDb?: InstanceType<typeof ResetSnapshotDB>;
}) {
  return new ArtifactService({
    synthesizerConfig: SYNTH_CONFIG,
    artifactDb: opts.artifactDb ?? new ArtifactDB(':memory:'),
    resetDb: opts.resetDb ?? new ResetSnapshotDB(':memory:'),
    handler: opts.handler,
    bus: new EventBus(),
  });
}

function makeMockProvider(chatImpl: LLMProvider['chat']): LLMProvider {
  return {
    name: 'mock',
    chat: vi.fn(chatImpl),
    summarize: async () => '',
    estimateTokens: () => 0,
  };
}

function defaultMockProvider(): LLMProvider {
  return makeMockProvider(
    async () => ({ content: ARTIFACT_BODY, tokensUsed: { input: 5, output: 50 } }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ArtifactService Phase 2/3 — synthesis + commit + rollback', () => {
  let mockProvider: LLMProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = defaultMockProvider();
    vi.mocked(factoryModule.createProvider).mockReturnValue(mockProvider);
  });

  // ── 1. Happy path ───────────────────────────────────────────────────────────

  describe('happy path', () => {
    it('calls provider, parses artifact, seals segment, inserts DB row, opens new segment, emits artifact.created', async () => {
      const handler = makeHandler();
      const artifactDb = new ArtifactDB(':memory:');
      const resetDb = new ResetSnapshotDB(':memory:');
      const bus = new EventBus();
      const busEmitSpy = vi.spyOn(bus, 'emit');

      const svc = new ArtifactService({
        synthesizerConfig: SYNTH_CONFIG,
        artifactDb,
        resetDb,
        handler,
        bus,
      });

      const result = await svc.synthesize(THREAD, 'universal');

      // Provider was called once.
      expect(mockProvider.chat).toHaveBeenCalledTimes(1);

      // DB row was inserted.
      expect(result.thread_id).toBe(THREAD);
      expect(result.preset).toBe('universal');
      expect(result.content_md).toBe(ARTIFACT_BODY);
      expect(result.synthesis_model).toBe('mock-model-v1');
      expect(result.thread_local_seq).toBe(1);
      expect(result.segment_index).toBe(0);

      // Segment was sealed then new segment opened.
      expect(handler.sealCurrentSegment).toHaveBeenCalledTimes(1);
      expect(handler.openNewSegment).toHaveBeenCalledTimes(1);

      // artifact.created was emitted with correct payload.
      expect(busEmitSpy).toHaveBeenCalledWith('artifact.created', {
        threadId: THREAD,
        segmentIndex: 0,
        threadLocalSeq: 1,
        preset: 'universal',
      });
    });

    it('clears synthesisInFlight on success path', async () => {
      const handler = makeHandler();
      const svc = makeService({ handler });

      await svc.synthesize(THREAD, 'universal');

      // setSynthesisInFlight was called with true then false.
      const calls = vi.mocked(handler.setSynthesisInFlight).mock.calls;
      expect(calls[0]).toEqual([THREAD, true]);
      expect(calls[calls.length - 1]).toEqual([THREAD, false]);
      // After completion the flag is false in state.
      expect(handler._state.synthesisInFlight).toBe(false);
    });
  });

  // ── 2. MalformedArtifactError — no retry ────────────────────────────────────

  describe('MalformedArtifactError', () => {
    it('throws MalformedArtifactError when provider returns text without ## TL;DR (1 invocation only)', async () => {
      const badProvider = makeMockProvider(
        async () => ({ content: 'Some response without the heading.', tokensUsed: { input: 5, output: 10 } }),
      );
      vi.mocked(factoryModule.createProvider).mockReturnValue(badProvider);

      const handler = makeHandler();
      const svc = makeService({ handler });

      await expect(svc.synthesize(THREAD, 'universal')).rejects.toThrow(MalformedArtifactError);

      // Only one call — MalformedArtifactError is NOT retried.
      expect(badProvider.chat).toHaveBeenCalledTimes(1);
    });

    it('does NOT seal segment or insert row on MalformedArtifactError', async () => {
      const badProvider = makeMockProvider(
        async () => ({ content: 'No heading here.', tokensUsed: { input: 5, output: 10 } }),
      );
      vi.mocked(factoryModule.createProvider).mockReturnValue(badProvider);

      const handler = makeHandler();
      const artifactDb = new ArtifactDB(':memory:');
      const svc = makeService({ handler, artifactDb });

      await expect(svc.synthesize(THREAD, 'universal')).rejects.toThrow(MalformedArtifactError);

      expect(handler.sealCurrentSegment).not.toHaveBeenCalled();
      expect(handler.openNewSegment).not.toHaveBeenCalled();
      // No row in DB.
      expect(artifactDb.findByThread(THREAD)).toHaveLength(0);
    });

    it('clears synthesisInFlight on MalformedArtifactError path', async () => {
      const badProvider = makeMockProvider(
        async () => ({ content: 'No heading here.', tokensUsed: { input: 5, output: 10 } }),
      );
      vi.mocked(factoryModule.createProvider).mockReturnValue(badProvider);

      const handler = makeHandler();
      const svc = makeService({ handler });

      await expect(svc.synthesize(THREAD, 'universal')).rejects.toThrow(MalformedArtifactError);

      expect(handler._state.synthesisInFlight).toBe(false);
    });
  });

  // ── 3. DB INSERT throws ──────────────────────────────────────────────────────

  describe('DB INSERT failure', () => {
    it('calls unsealCurrentSegment (rollback) when artifactDb.insert throws', async () => {
      const handler = makeHandler();
      const artifactDb = new ArtifactDB(':memory:');
      const insertErr = new Error('UNIQUE constraint failed');
      vi.spyOn(artifactDb, 'insert').mockImplementation(() => { throw insertErr; });

      const svc = makeService({ handler, artifactDb });

      await expect(svc.synthesize(THREAD, 'universal')).rejects.toThrow(insertErr);

      // sealCurrentSegment was called (Phase 3 began).
      expect(handler.sealCurrentSegment).toHaveBeenCalledTimes(1);
      // Rollback: unseal was called.
      expect(handler.unsealCurrentSegment).toHaveBeenCalledTimes(1);
      // openNewSegment must NOT be called (rolled back before reaching it).
      expect(handler.openNewSegment).not.toHaveBeenCalled();
    });

    it('clears synthesisInFlight when DB INSERT throws', async () => {
      const handler = makeHandler();
      const artifactDb = new ArtifactDB(':memory:');
      vi.spyOn(artifactDb, 'insert').mockImplementation(() => { throw new Error('DB fail'); });

      const svc = makeService({ handler, artifactDb });

      await expect(svc.synthesize(THREAD, 'universal')).rejects.toThrow('DB fail');

      expect(handler._state.synthesisInFlight).toBe(false);
    });
  });

  // ── 4. openNewSegment throws ─────────────────────────────────────────────────

  describe('openNewSegment failure', () => {
    it('calls deleteById AND unsealCurrentSegment (best-effort rollback) when openNewSegment throws', async () => {
      const handler = makeHandler();
      const artifactDb = new ArtifactDB(':memory:');
      const openErr = new Error('openNewSegment failed');
      vi.mocked(handler.openNewSegment).mockImplementation(() => { throw openErr; });
      const deleteByIdSpy = vi.spyOn(artifactDb, 'deleteById');

      const svc = makeService({ handler, artifactDb });

      await expect(svc.synthesize(THREAD, 'universal')).rejects.toThrow(openErr);

      // Both rollback steps called.
      expect(deleteByIdSpy).toHaveBeenCalledTimes(1);
      expect(handler.unsealCurrentSegment).toHaveBeenCalledTimes(1);
    });

    it('surfaces the original openErr (not cleanup errors) when openNewSegment throws', async () => {
      const handler = makeHandler();
      const artifactDb = new ArtifactDB(':memory:');
      const openErr = new Error('openNewSegment failed');
      vi.mocked(handler.openNewSegment).mockImplementation(() => { throw openErr; });

      const svc = makeService({ handler, artifactDb });

      const thrown = await svc.synthesize(THREAD, 'universal').catch(e => e);
      expect(thrown).toBe(openErr);
    });

    it('clears synthesisInFlight when openNewSegment throws', async () => {
      const handler = makeHandler();
      const artifactDb = new ArtifactDB(':memory:');
      vi.mocked(handler.openNewSegment).mockImplementation(() => { throw new Error('openNewSegment failed'); });

      const svc = makeService({ handler, artifactDb });

      await expect(svc.synthesize(THREAD, 'universal')).rejects.toThrow();

      expect(handler._state.synthesisInFlight).toBe(false);
    });
  });

  // ── 5. Best-effort rollback: both cleanup steps throw ───────────────────────

  describe('best-effort rollback — both cleanup steps throw', () => {
    it('logs both cleanup errors via console.error and still throws original openErr', async () => {
      const handler = makeHandler();
      const artifactDb = new ArtifactDB(':memory:');
      const openErr = new Error('openNewSegment failed');
      const delErr = new Error('deleteById failed');
      const unsealErr = new Error('unsealCurrentSegment failed');

      vi.mocked(handler.openNewSegment).mockImplementation(() => { throw openErr; });
      vi.spyOn(artifactDb, 'deleteById').mockImplementation(() => { throw delErr; });
      vi.mocked(handler.unsealCurrentSegment).mockImplementation(() => { throw unsealErr; });

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const svc = makeService({ handler, artifactDb });

      const thrown = await svc.synthesize(THREAD, 'universal').catch(e => e);

      // Original error surfaces.
      expect(thrown).toBe(openErr);

      // Both cleanup errors logged.
      expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
      const [call1, call2] = consoleErrorSpy.mock.calls;
      expect(call1[0]).toMatch(/deleteById/);
      expect(call1[1]).toBe(delErr);
      expect(call2[0]).toMatch(/unsealCurrentSegment/);
      expect(call2[1]).toBe(unsealErr);

      consoleErrorSpy.mockRestore();
    });
  });

  // ── 6. synthesisInFlight cleared on every exit path ─────────────────────────

  describe('synthesisInFlight invariant', () => {
    it('is always false after success', async () => {
      const handler = makeHandler();
      const svc = makeService({ handler });
      await svc.synthesize(THREAD, 'universal');
      expect(handler._state.synthesisInFlight).toBe(false);
    });

    it('is always false after MalformedArtifactError', async () => {
      vi.mocked(factoryModule.createProvider).mockReturnValue(
        makeMockProvider(async () => ({ content: 'no heading', tokensUsed: { input: 1, output: 1 } })),
      );
      const handler = makeHandler();
      const svc = makeService({ handler });
      await svc.synthesize(THREAD, 'universal').catch(() => {});
      expect(handler._state.synthesisInFlight).toBe(false);
    });

    it('is always false after DB INSERT throws', async () => {
      const handler = makeHandler();
      const artifactDb = new ArtifactDB(':memory:');
      vi.spyOn(artifactDb, 'insert').mockImplementation(() => { throw new Error('DB fail'); });
      const svc = makeService({ handler, artifactDb });
      await svc.synthesize(THREAD, 'universal').catch(() => {});
      expect(handler._state.synthesisInFlight).toBe(false);
    });

    it('is always false after openNewSegment throws', async () => {
      const handler = makeHandler();
      vi.mocked(handler.openNewSegment).mockImplementation(() => { throw new Error('open fail'); });
      const svc = makeService({ handler });
      await svc.synthesize(THREAD, 'universal').catch(() => {});
      expect(handler._state.synthesisInFlight).toBe(false);
    });
  });
});
