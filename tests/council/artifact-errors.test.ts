import { describe, it, expect } from 'vitest';
import {
  MissingSynthesizerConfigError,
  ArtifactEmptySegmentError,
  SynthesisAlreadyRunningError,
  ArtifactResetInFlightError,
  ArtifactDeliberationInFlightError,
  PendingClassificationError,
  ArtifactBlindReviewActiveError,
  MalformedArtifactError,
  EmptyResponseError,
  ProviderTimeoutError,
  SynthesisRetryExhaustedError,
} from '../../src/council/artifact-errors.js';

describe('artifact errors', () => {
  it('all classes extend Error and have unique names', () => {
    const instances = [
      new MissingSynthesizerConfigError(),
      new ArtifactEmptySegmentError(),
      new SynthesisAlreadyRunningError(42),
      new ArtifactResetInFlightError(42),
      new ArtifactDeliberationInFlightError(42),
      new PendingClassificationError(42),
      new ArtifactBlindReviewActiveError(42),
      new MalformedArtifactError('raw'),
      new EmptyResponseError(),
      new ProviderTimeoutError(30000),
      new SynthesisRetryExhaustedError(new Error('inner')),
    ];
    const names = instances.map(e => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const e of instances) expect(e).toBeInstanceOf(Error);
  });

  it('ProviderTimeoutError carries timeoutMs', () => {
    const e = new ProviderTimeoutError(30000);
    expect(e.timeoutMs).toBe(30000);
  });

  it('SynthesisRetryExhaustedError wraps inner cause', () => {
    const inner = new Error('boom');
    const e = new SynthesisRetryExhaustedError(inner);
    expect(e.cause).toBe(inner);
  });

  it('MalformedArtifactError carries raw response', () => {
    const e = new MalformedArtifactError('no TL;DR here');
    expect(e.rawResponse).toBe('no TL;DR here');
  });
});
