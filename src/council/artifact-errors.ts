/**
 * Error taxonomy for /councildone synthesis pipeline.
 * Names are artifact-prefixed where there is a clash with session-reset's
 * existing errors so adapters can distinguish without import aliasing.
 */

export class MissingSynthesizerConfigError extends Error {
  constructor() {
    super('No agent has role_type: artifact-synthesizer');
    this.name = 'MissingSynthesizerConfigError';
  }
}

export class ArtifactEmptySegmentError extends Error {
  constructor() {
    super('Current segment has no messages');
    this.name = 'ArtifactEmptySegmentError';
  }
}

export class SynthesisAlreadyRunningError extends Error {
  constructor(public readonly threadId: number) {
    super(`Synthesis already in flight for thread ${threadId}`);
    this.name = 'SynthesisAlreadyRunningError';
  }
}

export class ArtifactResetInFlightError extends Error {
  constructor(public readonly threadId: number) {
    super(`Reset in flight for thread ${threadId}; retry /councildone after reset completes`);
    this.name = 'ArtifactResetInFlightError';
  }
}

export class ArtifactDeliberationInFlightError extends Error {
  constructor(public readonly threadId: number) {
    super(`Deliberation in flight for thread ${threadId}; retry /councildone after the round ends`);
    this.name = 'ArtifactDeliberationInFlightError';
  }
}

export class PendingClassificationError extends Error {
  constructor(public readonly threadId: number) {
    super(`Message classification pending for thread ${threadId}; retry /councildone shortly`);
    this.name = 'PendingClassificationError';
  }
}

export class ArtifactBlindReviewActiveError extends Error {
  constructor(public readonly threadId: number) {
    super(`Blind review active for thread ${threadId}; resolve via /blindreview reveal or /cancelreview`);
    this.name = 'ArtifactBlindReviewActiveError';
  }
}

export class MalformedArtifactError extends Error {
  constructor(public readonly rawResponse: string) {
    super('Synthesizer output missing required ## TL;DR section');
    this.name = 'MalformedArtifactError';
  }
}

export class EmptyResponseError extends Error {
  constructor() {
    super('Synthesizer returned empty content (or provider empty-rewrite sentinel)');
    this.name = 'EmptyResponseError';
  }
}

export class ProviderTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Provider call exceeded ${timeoutMs}ms`);
    this.name = 'ProviderTimeoutError';
  }
}

export class SynthesisRetryExhaustedError extends Error {
  constructor(public readonly cause: unknown) {
    super(`Synthesis failed after retries; cause: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'SynthesisRetryExhaustedError';
  }
}
