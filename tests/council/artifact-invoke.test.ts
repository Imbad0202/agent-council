import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  invokeProviderForArtifact,
  isProviderEmptyResponse,
  isHardFail,
  invokeWithRetry,
} from '../../src/council/artifact-invoke.js';
import {
  ProviderTimeoutError,
  EmptyResponseError,
  SynthesisRetryExhaustedError,
} from '../../src/council/artifact-errors.js';
import type { LLMProvider, ProviderMessage, ChatOptions, ProviderResponse } from '../../src/types.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeProvider(chatImpl: () => Promise<ProviderResponse>): LLMProvider {
  return {
    name: 'mock',
    chat: vi.fn(chatImpl),
    summarize: async () => '',
    estimateTokens: () => 0,
  };
}

const MESSAGES: ProviderMessage[] = [{ role: 'user', content: 'summarise the discussion' }];
const OPTIONS: ChatOptions = { model: 'claude-sonnet-4-5', systemPrompt: 'You are a synthesizer.' };
const GOOD_RESPONSE: ProviderResponse = {
  content: '## TL;DR\n\nWe reached a decision.',
  tokensUsed: { input: 100, output: 50 },
};

// ---------------------------------------------------------------------------
// invokeProviderForArtifact
// ---------------------------------------------------------------------------

describe('invokeProviderForArtifact', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves provider response when chat finishes within timeout', async () => {
    const provider = makeProvider(async () => GOOD_RESPONSE);
    const result = await invokeProviderForArtifact(provider, MESSAGES, OPTIONS, 5000);
    expect(result).toEqual(GOOD_RESPONSE);
  });

  it('rejects with ProviderTimeoutError when chat exceeds timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const neverResolves = new Promise<ProviderResponse>(() => {});
    const provider = makeProvider(() => neverResolves);

    // Attach a catch handler BEFORE advancing timers so the rejection is
    // immediately handled. Without this, vitest fake-timer callbacks fire
    // the rejection asynchronously after the tick, resulting in an
    // "unhandled rejection" warning even though we do await below.
    const racePromise = invokeProviderForArtifact(provider, MESSAGES, OPTIONS, 100);
    const handled = racePromise.catch(e => e); // swallow for handling below

    // Advance past the timeout; microtasks flush between ticks.
    await vi.advanceTimersByTimeAsync(200);

    const err = await handled;
    expect(err).toBeInstanceOf(ProviderTimeoutError);
  });

  it('clears the scheduled timer on success path', async () => {
    // Both spies must be installed BEFORE useFakeTimers replaces the globals,
    // so we target globalThis directly.
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const provider = makeProvider(async () => GOOD_RESPONSE);
    await invokeProviderForArtifact(provider, MESSAGES, OPTIONS, 5000);

    expect(setTimeoutSpy).toHaveBeenCalled();
    expect(clearTimeoutSpy).toHaveBeenCalled();

    // Stronger contract: clearTimeout must receive the SAME handle that
    // setTimeout returned. Without this, future code that calls
    // clearTimeout(undefined) or clearTimeout(otherHandle) would still
    // pass the weaker `toHaveBeenCalled` check above.
    const handle = setTimeoutSpy.mock.results[0].value;
    expect(clearTimeoutSpy).toHaveBeenCalledWith(handle);

    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// isProviderEmptyResponse
// ---------------------------------------------------------------------------

describe('isProviderEmptyResponse', () => {
  it('matches literal empty string', () => {
    expect(isProviderEmptyResponse('')).toBe(true);
  });

  it('matches whitespace-only strings', () => {
    expect(isProviderEmptyResponse('   ')).toBe(true);
    expect(isProviderEmptyResponse('\n\t')).toBe(true);
  });

  it('matches OpenAI empty-rewrite sentinel (finish_reason: length)', () => {
    expect(isProviderEmptyResponse('（gpt-5 未回傳內容，finish_reason: length）')).toBe(true);
  });

  it('matches OpenAI sentinel with extra whitespace finish_reason', () => {
    expect(isProviderEmptyResponse('（gpt-4o 未回傳內容，finish_reason: stop）')).toBe(true);
  });

  it('does NOT match real markdown content with parens', () => {
    expect(isProviderEmptyResponse('## TL;DR\n\nWe agreed (with caveats).')).toBe(false);
  });

  it('does NOT match a full sentence that happens to contain parens', () => {
    expect(isProviderEmptyResponse('The result is positive (see discussion above).')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isHardFail
// ---------------------------------------------------------------------------

describe('isHardFail', () => {
  it('ProviderTimeoutError → false (retry)', () => {
    expect(isHardFail(new ProviderTimeoutError(30_000))).toBe(false);
  });

  it('EmptyResponseError → false (retry)', () => {
    expect(isHardFail(new EmptyResponseError())).toBe(false);
  });

  it('error with status 429 → false (retry)', () => {
    const err = Object.assign(new Error('rate limited'), { status: 429 });
    expect(isHardFail(err)).toBe(false);
  });

  it('error with status 503 (5xx) → false (retry)', () => {
    const err = Object.assign(new Error('server error'), { status: 503 });
    expect(isHardFail(err)).toBe(false);
  });

  it('error with status 401 → true (hard fail)', () => {
    const err = Object.assign(new Error('unauthorized'), { status: 401 });
    expect(isHardFail(err)).toBe(true);
  });

  it('error with status 404 → true (hard fail)', () => {
    const err = Object.assign(new Error('not found'), { status: 404 });
    expect(isHardFail(err)).toBe(true);
  });

  it('plain Error without .status → false (retry conservatively, spec §8)', () => {
    expect(isHardFail(new Error('network blip'))).toBe(false);
  });

  it('returns false for an Error whose .status is undefined (retry conservatively)', () => {
    const err = Object.assign(new Error('weird'), { status: undefined });
    expect(isHardFail(err)).toBe(false);
  });

  const fakeGoogle = { name: 'google' } as unknown as LLMProvider;
  const fakeClaude = { name: 'claude' } as unknown as LLMProvider;

  it('ProviderTimeoutError + Google provider → true (hard fail)', () => {
    expect(isHardFail(new ProviderTimeoutError(30_000), fakeGoogle)).toBe(true);
  });

  it('ProviderTimeoutError + Claude provider → false (retry)', () => {
    expect(isHardFail(new ProviderTimeoutError(30_000), fakeClaude)).toBe(false);
  });

  it('ProviderTimeoutError + no provider arg → false (back-compat)', () => {
    expect(isHardFail(new ProviderTimeoutError(30_000))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// invokeWithRetry
// ---------------------------------------------------------------------------

describe('invokeWithRetry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns response on first success (1 invocation)', async () => {
    const provider = makeProvider(async () => GOOD_RESPONSE);
    const result = await invokeWithRetry(provider, MESSAGES, OPTIONS);
    expect(result).toEqual(GOOD_RESPONSE);
    expect(provider.chat as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it('OpenAI sentinel on attempt 1, valid markdown on attempt 2 → returns valid (2 invocations) — regression test for round-10 P2-3', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const sentinel = '（gpt-4o 未回傳內容，finish_reason: length）';
    let callCount = 0;
    const provider = makeProvider(async () => {
      callCount++;
      if (callCount === 1) return { content: sentinel, tokensUsed: { input: 10, output: 0 } };
      return GOOD_RESPONSE;
    });

    const retryPromise = invokeWithRetry(provider, MESSAGES, OPTIONS);

    // Advance past the first inter-attempt sleep (1000 ms).
    await vi.advanceTimersByTimeAsync(1500);

    const result = await retryPromise;
    expect(result).toEqual(GOOD_RESPONSE);
    expect(callCount).toBe(2);
  });

  it('401 hard-fails immediately (1 invocation)', async () => {
    const hardErr = Object.assign(new Error('unauthorized'), { status: 401 });
    const provider = makeProvider(async () => { throw hardErr; });

    await expect(invokeWithRetry(provider, MESSAGES, OPTIONS)).rejects.toThrow('unauthorized');
    expect(provider.chat as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it('plain Error on every attempt → throws SynthesisRetryExhaustedError after 4 attempts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const transientErr = new Error('network blip');
    const provider = makeProvider(async () => { throw transientErr; });

    // Attach a catch handler BEFORE advancing timers so the eventual
    // SynthesisRetryExhaustedError is immediately handled once it fires,
    // preventing the "unhandled rejection" warning from vitest's fake-timer
    // async callbacks.
    const retryPromise = invokeWithRetry(provider, MESSAGES, OPTIONS);
    const handled = retryPromise.catch(e => e);

    // Advance past all inter-attempt sleeps: 1000 + 2000 + 4000 = 7000 ms total.
    await vi.advanceTimersByTimeAsync(8000);

    const err = await handled;
    expect(err).toBeInstanceOf(SynthesisRetryExhaustedError);
    expect(provider.chat as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(4);
  });
});
