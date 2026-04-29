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
  GoogleProviderTimeoutError,
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

  it('threadId-bearing errors expose threadId payload', () => {
    expect(new SynthesisAlreadyRunningError(7).threadId).toBe(7);
    expect(new ArtifactResetInFlightError(8).threadId).toBe(8);
    expect(new ArtifactDeliberationInFlightError(9).threadId).toBe(9);
    expect(new PendingClassificationError(10).threadId).toBe(10);
    expect(new ArtifactBlindReviewActiveError(11).threadId).toBe(11);
  });
});

describe('GoogleProviderTimeoutError', () => {
  it('extends ProviderTimeoutError', () => {
    const e = new GoogleProviderTimeoutError(30_000);
    expect(e).toBeInstanceOf(ProviderTimeoutError);
    expect(e).toBeInstanceOf(Error);
  });

  it('has name "GoogleProviderTimeoutError"', () => {
    const e = new GoogleProviderTimeoutError(30_000);
    expect(e.name).toBe('GoogleProviderTimeoutError');
  });

  it('carries timeoutMs from parent', () => {
    const e = new GoogleProviderTimeoutError(45_000);
    expect(e.timeoutMs).toBe(45_000);
  });

  it('message includes Google-specific disclosure', () => {
    const e = new GoogleProviderTimeoutError(30_000);
    expect(e.message).toContain('Google');
    expect(e.message).toContain('server-side');
    expect(e.message).toContain('30000');
  });
});
