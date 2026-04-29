import type { LLMProvider, ProviderMessage, ProviderResponse, ChatOptions } from '../types.js';
import {
  ProviderTimeoutError, EmptyResponseError, SynthesisRetryExhaustedError,
  GoogleProviderTimeoutError,
} from './artifact-errors.js';
import { TimeoutReason, isAbortError, mergeSignals } from '../abort-utils.js';

const PER_ATTEMPT_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 4;
const SLEEPS_MS = [1000, 2000, 4000];

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * v0.5.3: race + native abort. The setTimeout drives both the deterministic
 * race exit (reject ProviderTimeoutError) and a best-effort SDK abort
 * (timeoutCtrl.abort) so cooperating providers stop their HTTP request.
 *
 * Cause classification (v0.5.3 §3.3):
 * - race wins → ProviderTimeoutError (synchronous reject before abort)
 * - SDK rethrows TimeoutReason → ProviderTimeoutError
 * - SDK rethrows AbortError but merged.reason is TimeoutReason → ProviderTimeoutError
 * - SDK rethrows AbortError with caller's reason → re-throw (caller cancellation)
 * - non-abort error → re-throw
 */
export async function invokeProviderForArtifact(
  provider: LLMProvider,
  messages: ProviderMessage[],
  options: ChatOptions,
  perAttemptTimeoutMs: number = PER_ATTEMPT_TIMEOUT_MS,
): Promise<ProviderResponse> {
  const timeoutCtrl = new AbortController();
  const merged = mergeSignals(options.signal, timeoutCtrl.signal);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      provider.chat(messages, { ...options, signal: merged }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          timeoutCtrl.abort(new TimeoutReason(perAttemptTimeoutMs));
          reject(new ProviderTimeoutError(perAttemptTimeoutMs));
        }, perAttemptTimeoutMs);
      }),
    ]);
  } catch (err) {
    if (err instanceof TimeoutReason) {
      throw new ProviderTimeoutError(perAttemptTimeoutMs);
    }
    if (err instanceof ProviderTimeoutError) {
      throw err;
    }
    if (isAbortError(err)) {
      if (merged?.aborted && merged.reason instanceof TimeoutReason) {
        throw new ProviderTimeoutError(perAttemptTimeoutMs);
      }
      throw err;
    }
    throw err;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/** OpenAI provider rewrites empty completions into this Chinese sentinel. */
const OPENAI_EMPTY_SENTINEL = /^（[^（）]+未回傳內容，finish_reason:\s*[^）]+）\s*$/;

export function isProviderEmptyResponse(content: string): boolean {
  if (!content || content.trim().length === 0) return true;
  if (OPENAI_EMPTY_SENTINEL.test(content.trim())) return true;
  return false;
}

export function isHardFail(err: unknown, provider?: LLMProvider): boolean {
  if (err instanceof ProviderTimeoutError && provider?.name === 'google') {
    return true;
  }
  if (err instanceof ProviderTimeoutError) return false;
  if (err instanceof EmptyResponseError) return false;
  if (err instanceof Error && 'status' in err) {
    const status = (err as { status: number }).status;
    if (status === 429) return false;
    if (status >= 500 && status < 600) return false;
    if (status >= 400 && status < 500) return true;
  }
  return false;
}

export async function invokeWithRetry(
  provider: LLMProvider,
  messages: ProviderMessage[],
  options: ChatOptions,
  perAttemptTimeoutMs: number = PER_ATTEMPT_TIMEOUT_MS,
): Promise<ProviderResponse> {
  // Round-1 codex P2-1 + round-2 P2: short-circuit retry loop on caller
  // cancellation, BOTH before sleep and after sleep — abort during backoff
  // would otherwise let another LLM request start.
  const checkAborted = () => {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new DOMException('aborted', 'AbortError');
    }
  };

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    checkAborted();
    if (attempt > 1) await sleep(SLEEPS_MS[attempt - 2]);
    checkAborted(); // round-2 P2: re-check after backoff before next attempt
    try {
      const response = await invokeProviderForArtifact(
        provider, messages, options, perAttemptTimeoutMs,
      );
      if (isProviderEmptyResponse(response.content)) {
        lastErr = new EmptyResponseError();
        continue;
      }
      return response;
    } catch (err) {
      lastErr = err;
      // Round-1 P2-1 + round-2 P2 + round-3 P2: caller cancellation is terminal,
      // regardless of the error shape the SDK/fetch threw. If options.signal is
      // aborted at this point, the caller wants out — surface the cancellation
      // reason directly. This catches BOTH AbortError-shaped exceptions AND
      // raw Error rejections that fetch surfaces when signal.reason is an Error
      // (CustomProvider path) AND any other shape we haven't anticipated.
      if (options.signal?.aborted) {
        throw options.signal.reason instanceof Error
          ? options.signal.reason
          : err;
      }
      if (isHardFail(err, provider)) {
        if (err instanceof ProviderTimeoutError && provider.name === 'google') {
          throw new GoogleProviderTimeoutError(err.timeoutMs);
        }
        throw err;
      }
    }
  }
  throw new SynthesisRetryExhaustedError(lastErr);
}
