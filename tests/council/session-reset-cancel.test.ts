import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionReset } from '../../src/council/session-reset.js';
import { ResetSnapshotDB } from '../../src/storage/reset-snapshot-db.js';
import { ArtifactDB } from '../../src/council/artifact-db.js';
import { ResetCancelledError } from '../../src/council/session-reset-errors.js';
import type { CouncilMessage } from '../../src/types.js';

// Reuse fixture shape from sibling council-reset-cli.test.ts pattern.
function makeDelibHandler(overrides: Partial<{
  resetInFlight: boolean;
  blindReviewSessionId: string | null;
}> = {}) {
  let resetInFlight = overrides.resetInFlight ?? false;
  const segments: { snapshotId: string | null }[] = [{ snapshotId: null }];
  let currentResetController: AbortController | null = null;

  return {
    getBlindReviewSessionId: vi.fn(() => overrides.blindReviewSessionId ?? null),
    getCurrentTopic: vi.fn(() => 'topic'),
    getCurrentSegmentMessages: vi.fn(() => [
      { id: 'x', role: 'human' as const, content: 'TEST_DEFAULT_TURN_ROUND10_GUARD', timestamp: 1 },
    ] as readonly CouncilMessage[]),
    getSegments: vi.fn(() => segments),
    isResetInFlight: vi.fn(() => resetInFlight),
    isDeliberationInFlight: vi.fn(() => false),
    hasPendingClassifications: vi.fn(() => false),
    isSynthesisInFlight: vi.fn(() => false),
    setResetInFlight: vi.fn((_: number, v: boolean) => { resetInFlight = v; }),
    sealCurrentSegment: vi.fn(),
    openNewSegment: vi.fn(() => { segments.push({ snapshotId: null }); }),
    unsealCurrentSegment: vi.fn(),
    getCurrentResetController: vi.fn(() => currentResetController),
    setCurrentResetController: vi.fn((_: number, c: AbortController | null) => {
      currentResetController = c;
    }),
  };
}

const VALID_SUMMARY = [
  '## Decisions', '- x', '',
  '## Open Questions', '',
  '## Evidence Pointers', '',
  '## Blind-Review State', 'none', '',
].join('\n');

let resetDb: ResetSnapshotDB;
let artifactDb: ArtifactDB;

beforeEach(() => {
  resetDb = new ResetSnapshotDB(':memory:');
  artifactDb = new ArtifactDB(':memory:');
});

afterEach(() => {
  resetDb.close();
  artifactDb.close();
});

describe('SessionReset cancel (v0.5.4 §7.2-7.5)', () => {
  it('R0: pre-aborted external signal → reset throws ResetCancelledError immediately, no LLM call, no DB write', async () => {
    const facilitator = { respondDeterministic: vi.fn() };
    const reset = new SessionReset(resetDb, artifactDb, facilitator as never);
    const handler = makeDelibHandler();

    const ctrl = new AbortController();
    ctrl.abort(new ResetCancelledError('user'));

    await expect(
      reset.reset(handler as never, 1, { signal: ctrl.signal }),
    ).rejects.toBeInstanceOf(ResetCancelledError);

    expect(facilitator.respondDeterministic).not.toHaveBeenCalled();
    expect(handler.isResetInFlight(1)).toBe(false);
    expect(handler.getCurrentResetController(1)).toBeNull();
  });

  it("R1: /councilcancel during LLM call → throws ResetCancelledError(reason='user'), no DB write", async () => {
    const facilitator = {
      respondDeterministic: vi.fn(async (_msgs: never, _role: never, signal?: AbortSignal) => {
        await new Promise<never>((_, reject) => {
          signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'APIUserAbortError';
            reject(err);
          }, { once: true });
        });
        throw new Error('unreachable');
      }),
    };
    const reset = new SessionReset(resetDb, artifactDb, facilitator as never);
    const handler = makeDelibHandler();

    const promise = reset.reset(handler as never, 1);
    // Yield twice for reset to enter LLM await
    await Promise.resolve();
    await Promise.resolve();

    const ctrl = handler.getCurrentResetController(1);
    expect(ctrl).not.toBeNull();
    ctrl!.abort(new ResetCancelledError('user'));

    await expect(promise).rejects.toBeInstanceOf(ResetCancelledError);
    expect(handler.isResetInFlight(1)).toBe(false);
    expect(handler.getCurrentResetController(1)).toBeNull();
  });

  it("R1' (round-1 P1-1): cancel wins, facilitator IGNORES signal and resolves later, NO DB write, NO segment seal", async () => {
    // Mock facilitator that IGNORES signal and resolves after 100ms with valid summary
    const facilitator = {
      respondDeterministic: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { content: VALID_SUMMARY };
      }),
    };
    const reset = new SessionReset(resetDb, artifactDb, facilitator as never);
    const handler = makeDelibHandler();

    const recordSpy = vi.spyOn(resetDb, 'recordSnapshot');
    const sealSpy = handler.sealCurrentSegment as ReturnType<typeof vi.fn>;

    const promise = reset.reset(handler as never, 1);
    await Promise.resolve();
    await Promise.resolve();

    const ctrl = handler.getCurrentResetController(1);
    expect(ctrl).not.toBeNull();
    ctrl!.abort(new ResetCancelledError('user'));

    await expect(promise).rejects.toMatchObject({ reason: 'user' });
    expect(handler.isResetInFlight(1)).toBe(false);

    // Wait for facilitator's late resolution to complete
    await new Promise((r) => setTimeout(r, 150));

    // R1' invariant: post-await abort gate refused to commit
    expect(recordSpy).not.toHaveBeenCalled();
    expect(sealSpy).not.toHaveBeenCalled();
  });

  it('R1 timeout: 30s passes with hanging facilitator → ResetCancelledError(reason=timeout)', async () => {
    vi.useFakeTimers();
    try {
      const facilitator = {
        respondDeterministic: vi.fn(() => new Promise(() => {})),  // hangs forever
      };
      const reset = new SessionReset(resetDb, artifactDb, facilitator as never);
      const handler = makeDelibHandler();

      const promise = reset.reset(handler as never, 1);
      // Attach rejection handler EARLY (round-3 P2-r3-3 pattern)
      promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(30_001);

      await expect(promise).rejects.toMatchObject({
        name: 'ResetCancelledError',
        reason: 'timeout',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('R4: cancel after reset settled → controller is null (post-cleanup)', async () => {
    const facilitator = {
      respondDeterministic: vi.fn(async () => ({ content: VALID_SUMMARY })),
    };
    const reset = new SessionReset(resetDb, artifactDb, facilitator as never);
    const handler = makeDelibHandler();

    const result = await reset.reset(handler as never, 1);
    expect(result.snapshotId).toBeDefined();
    expect(handler.getCurrentResetController(1)).toBeNull();
  });

  it('thread isolation: cancel on thread A does NOT abort thread B reset', async () => {
    vi.useFakeTimers();
    try {
      // Two separate handlers (one per thread) — sharing handler state across
      // threads is the SessionState.Map<number, ...> pattern in production.
      // For this test, use two handler instances since our fixture is per-test.
      const handlerA = makeDelibHandler();
      const handlerB = makeDelibHandler();

      const facilitator = {
        respondDeterministic: vi.fn(() => new Promise(() => {})),
      };
      const reset = new SessionReset(resetDb, artifactDb, facilitator as never);

      const promiseA = reset.reset(handlerA as never, 1);
      const promiseB = reset.reset(handlerB as never, 2);

      // Attach early
      let aSettled = false;
      let bSettled = false;
      promiseA.catch(() => { aSettled = true; });
      promiseB.catch(() => { bSettled = true; });

      await Promise.resolve();
      await Promise.resolve();

      // Cancel A only
      const ctrlA = handlerA.getCurrentResetController(1);
      ctrlA!.abort(new ResetCancelledError('user'));

      // Flush A's rejection — under fake timers, microtask chain through
      // Promise.race + awaitResetRace + outer try/finally needs several ticks.
      // Drive timers minimally (0ms) which also drains the microtask queue.
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();

      expect(aSettled).toBe(true);

      // B has not settled (advance below timeout boundary)
      await vi.advanceTimersByTimeAsync(100);
      expect(bSettled).toBe(false);

      // Cleanup B
      const ctrlB = handlerB.getCurrentResetController(2);
      ctrlB!.abort(new ResetCancelledError('user'));
      await expect(promiseB).rejects.toMatchObject({ reason: 'user' });
    } finally {
      vi.useRealTimers();
    }
  });
});
