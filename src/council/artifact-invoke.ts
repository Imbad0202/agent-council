import type { LLMProvider, ProviderMessage, ProviderResponse, ChatOptions } from '../types.js';
import {
  ProviderTimeoutError, EmptyResponseError, SynthesisRetryExhaustedError,
} from './artifact-errors.js';

const PER_ATTEMPT_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 4;
const SLEEPS_MS = [1000, 2000, 4000];

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Caller-side timeout via Promise.race. Underlying fetch is NOT cancelled.
 *
 * KNOWN LIMITATION (spec §5): under retry storm with hung provider, up to
 * MAX_ATTEMPTS concurrent in-flight LLM calls can accumulate. Caller-visible
 * bound is ~127s but token cost can be ~4× per attempt budget. v0.5.3+
 * AbortSignal threading is the real fix.
 */
export async function invokeProviderForArtifact(
  provider: LLMProvider,
  messages: ProviderMessage[],
  options: ChatOptions,
  perAttemptTimeoutMs: number = PER_ATTEMPT_TIMEOUT_MS,
): Promise<ProviderResponse> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      provider.chat(messages, options),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new ProviderTimeoutError(perAttemptTimeoutMs)),
          perAttemptTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

/** OpenAI provider rewrites empty completions into this Chinese sentinel. */
const OPENAI_EMPTY_SENTINEL = /^（[^（）]+未回傳內容，finish_reason:\s*[^）]+）\s*$/;

export function isProviderEmptyResponse(content: string): boolean {
  if (!content || content.trim().length === 0) return true;
  if (OPENAI_EMPTY_SENTINEL.test(content.trim())) return true;
  return false;
}

export function isHardFail(err: unknown): boolean {
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
): Promise<ProviderResponse> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(SLEEPS_MS[attempt - 2]);
    try {
      const response = await invokeProviderForArtifact(
        provider, messages, options, PER_ATTEMPT_TIMEOUT_MS,
      );
      if (isProviderEmptyResponse(response.content)) {
        lastErr = new EmptyResponseError();
        continue;
      }
      return response;
    } catch (err) {
      lastErr = err;
      if (isHardFail(err)) throw err;
    }
  }
  throw new SynthesisRetryExhaustedError(lastErr);
}
