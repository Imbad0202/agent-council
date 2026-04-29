export class TimeoutReason extends Error {
  constructor(public readonly perAttemptMs: number) {
    super(`Per-attempt timeout after ${perAttemptMs}ms`);
    this.name = 'TimeoutReason';
  }
}
