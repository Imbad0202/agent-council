export class TimeoutReason extends Error {
  constructor(public readonly perAttemptMs: number) {
    super(`Per-attempt timeout after ${perAttemptMs}ms`);
    this.name = 'TimeoutReason';
  }
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; code?: string; constructor?: { name?: string } };
  if (e.name === 'AbortError') return true;
  if (e.code === 'ABORT_ERR') return true;
  if (e.constructor?.name === 'APIUserAbortError') return true;
  return false;
}

export function mergeSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

export function isTimeoutAbort(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof TimeoutReason;
}
