import { describe, it, expect, vi } from 'vitest';
import {
  invokeProviderForArtifact,
  invokeWithRetry,
  isHardFail,
} from '../../src/council/artifact-invoke.js';
import {
  ProviderTimeoutError,
  GoogleProviderTimeoutError,
  EmptyResponseError,
  SynthesisRetryExhaustedError,
} from '../../src/council/artifact-errors.js';
import { TimeoutReason, isAbortError } from '../../src/abort-utils.js';
import type { LLMProvider } from '../../src/types.js';

function makeProvider(opts: {
  name: 'claude' | 'openai' | 'google' | 'custom';
  behavior: 'hang' | 'reject-on-signal' | 'success' | 'throws';
  throwError?: Error;
}): LLMProvider {
  return {
    name: opts.name,
    chat: vi.fn(async (_msgs, options: { signal?: AbortSignal }) => {
      if (opts.behavior === 'success') {
        return { content: 'ok', model: 'm', tokensUsed: { input: 1, output: 1 } };
      }
      if (opts.behavior === 'throws') {
        throw opts.throwError ?? new Error('thrown');
      }
      if (opts.behavior === 'hang') {
        return new Promise(() => {});
      }
      return new Promise((_, reject) => {
        options.signal?.addEventListener('abort', () => {
          const err = Object.assign(new Error('aborted'), {
            constructor: { name: 'APIUserAbortError' },
          });
          reject(err);
        });
      });
    }),
    estimateTokens: () => 0,
    summarize: async () => '',
    chatWithFallback: async () => ({ content: '', model: '', tokensUsed: { input: 0, output: 0 } }),
  } as unknown as LLMProvider;
}

const MESSAGES = [{ role: 'user' as const, content: 'hi' }];
const OPTS = { model: 'm', systemPrompt: 'sys' };

describe('invokeProviderForArtifact (v0.5.3 race + signal)', () => {
  it('hung provider → ProviderTimeoutError after timeout AND signal aborted', async () => {
    const provider = makeProvider({ name: 'claude', behavior: 'reject-on-signal' });
    let caught: unknown;
    try {
      await invokeProviderForArtifact(provider, MESSAGES, OPTS, 50);
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ProviderTimeoutError);
  });

  it('caller cancellation surfaces as caller cancellation, not timeout', async () => {
    const provider = makeProvider({ name: 'claude', behavior: 'reject-on-signal' });
    const callerCtrl = new AbortController();
    setTimeout(() => callerCtrl.abort(new Error('user cancelled')), 10);
    let caught: unknown;
    try {
      await invokeProviderForArtifact(
        provider, MESSAGES,
        { ...OPTS, signal: callerCtrl.signal },
        10_000,
      );
    } catch (e) { caught = e; }
    expect(caught).not.toBeInstanceOf(ProviderTimeoutError);
    expect(isAbortError(caught)).toBe(true);
  });

  it('TimeoutReason thrown directly (CustomProvider fetch path) → ProviderTimeoutError', async () => {
    const provider = makeProvider({
      name: 'custom',
      behavior: 'throws',
      throwError: new TimeoutReason(50),
    });
    let caught: unknown;
    try {
      await invokeProviderForArtifact(provider, MESSAGES, OPTS, 50);
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ProviderTimeoutError);
  });

  it('successful chat returns response (no race interference)', async () => {
    const provider = makeProvider({ name: 'openai', behavior: 'success' });
    const r = await invokeProviderForArtifact(provider, MESSAGES, OPTS, 5000);
    expect(r.content).toBe('ok');
  });

  it('non-abort error rethrown unchanged', async () => {
    const err = new Error('network');
    const provider = makeProvider({ name: 'openai', behavior: 'throws', throwError: err });
    let caught: unknown;
    try {
      await invokeProviderForArtifact(provider, MESSAGES, OPTS, 5000);
    } catch (e) { caught = e; }
    expect(caught).toBe(err);
  });
});

describe('invokeWithRetry retry-storm bound', () => {
  it('Test E (Claude): 4 timeouts → ≤1 in-flight, sequential settle', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const settledOrder: number[] = [];
    let attemptId = 0;

    const provider: LLMProvider = {
      name: 'claude',
      chat: vi.fn(async (_msgs, options: { signal?: AbortSignal }) => {
        const id = ++attemptId;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          await new Promise((_, reject) => {
            options.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          });
        } finally {
          inFlight--;
          settledOrder.push(id);
        }
        throw new Error('unreachable');
      }),
    } as unknown as LLMProvider;

    // Round-1 codex P2-2: inject 50ms per-attempt timeout instead of waiting
    // production 30s × 4 = 120s. Same retry-storm invariant proven.
    // Real time: 4 × 50ms + (1+2+4)s sleeps = ~7.2s. Override vitest's 5s default.
    let caught: unknown;
    try {
      await invokeWithRetry(provider, MESSAGES, { ...OPTS }, 50);
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(SynthesisRetryExhaustedError);
    expect(maxInFlight).toBe(1);
    expect(settledOrder).toEqual([1, 2, 3, 4]);
  }, 15_000);

  it('Test E-Google: 1 timeout → GoogleProviderTimeoutError, no further attempts', async () => {
    let attemptCount = 0;
    const provider: LLMProvider = {
      name: 'google',
      chat: vi.fn(async (_msgs, options: { signal?: AbortSignal }) => {
        attemptCount++;
        await new Promise((_, reject) => {
          options.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')));
        });
        throw new Error('unreachable');
      }),
    } as unknown as LLMProvider;

    // Round-1 codex P2-2: inject 50ms per-attempt timeout instead of 30s.
    let caught: unknown;
    try {
      await invokeWithRetry(provider, MESSAGES, { ...OPTS }, 50);
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(GoogleProviderTimeoutError);
    expect(caught).toBeInstanceOf(ProviderTimeoutError);
    expect((caught as Error).message).toContain('Google');
    expect((caught as Error).message).toContain('server-side');
    expect(attemptCount).toBe(1);
  });

  // Round-1 codex P2-1: caller cancellation must short-circuit the retry loop.
  it('pre-aborted caller signal → 0 attempts, surfaces caller error directly', async () => {
    let attemptCount = 0;
    const provider: LLMProvider = {
      name: 'claude',
      chat: vi.fn(async () => {
        attemptCount++;
        return { content: 'unreachable', model: 'm', tokensUsed: { input: 0, output: 0 } };
      }),
    } as unknown as LLMProvider;

    const ctrl = new AbortController();
    const reason = new Error('user cancelled');
    ctrl.abort(reason);

    let caught: unknown;
    try {
      await invokeWithRetry(provider, MESSAGES, { ...OPTS, signal: ctrl.signal }, 50);
    } catch (e) { caught = e; }
    expect(caught).toBe(reason); // surfaces caller's reason directly, not wrapped
    expect(caught).not.toBeInstanceOf(SynthesisRetryExhaustedError);
    expect(attemptCount).toBe(0); // no attempts at all
  });

  // Round-2 codex P2: caller abort during backoff sleep must short-circuit
  // before next attempt starts — providers that don't synchronously reject
  // pre-aborted signals would otherwise burn another request.
  it('caller signal aborts during backoff sleep → no further attempts', async () => {
    let attemptCount = 0;
    const ctrl = new AbortController();
    const provider: LLMProvider = {
      name: 'claude',
      chat: vi.fn(async () => {
        attemptCount++;
        // First attempt fails with non-hard-fail (triggers backoff sleep)
        throw new Error('transient');
      }),
    } as unknown as LLMProvider;

    // Abort during the first backoff sleep (1s default; we use 50ms timeout
    // so backoff is 1s real time per SLEEPS_MS). Abort 50ms in.
    setTimeout(() => ctrl.abort(new Error('cancelled during backoff')), 50);

    let caught: unknown;
    try {
      await invokeWithRetry(provider, MESSAGES, { ...OPTS, signal: ctrl.signal }, 50);
    } catch (e) { caught = e; }
    expect((caught as Error).message).toContain('cancelled during backoff');
    expect(attemptCount).toBe(1); // ONLY 1 attempt — abort caught after sleep
    expect(caught).not.toBeInstanceOf(SynthesisRetryExhaustedError);
  }, 5_000);

  it('caller signal aborts mid-retry → stops retry loop on next iteration', async () => {
    let attemptCount = 0;
    const ctrl = new AbortController();
    const provider: LLMProvider = {
      name: 'claude',
      chat: vi.fn(async (_msgs, options: { signal?: AbortSignal }) => {
        attemptCount++;
        // Each attempt fails fast (non-hard-fail) so loop continues
        if (attemptCount === 1) {
          throw new Error('transient'); // not hard-fail, will retry
        }
        // After first attempt, caller aborts — loop should exit before attempt 3
        ctrl.abort(new Error('user cancelled mid-retry'));
        return new Promise((_, reject) => {
          options.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')));
        });
      }),
    } as unknown as LLMProvider;

    let caught: unknown;
    try {
      await invokeWithRetry(provider, MESSAGES, { ...OPTS, signal: ctrl.signal }, 50);
    } catch (e) { caught = e; }
    expect(caught).not.toBeInstanceOf(SynthesisRetryExhaustedError);
    expect(isAbortError(caught) || (caught as Error).message?.includes('cancelled')).toBe(true);
    expect(attemptCount).toBeLessThanOrEqual(2); // 1st transient, 2nd aborted, no 3rd
  });
});
