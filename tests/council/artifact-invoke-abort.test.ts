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

    let caught: unknown;
    try {
      await invokeWithRetry(provider, MESSAGES, { ...OPTS });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(SynthesisRetryExhaustedError);
    expect(maxInFlight).toBe(1);
    expect(settledOrder).toEqual([1, 2, 3, 4]);
  }, 180_000);

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

    let caught: unknown;
    try {
      await invokeWithRetry(provider, MESSAGES, { ...OPTS });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(GoogleProviderTimeoutError);
    expect(caught).toBeInstanceOf(ProviderTimeoutError);
    expect((caught as Error).message).toContain('Google');
    expect((caught as Error).message).toContain('server-side');
    expect(attemptCount).toBe(1);
  }, 60_000);
});
