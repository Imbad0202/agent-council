import { describe, it, expect } from 'vitest';
import { awaitResetRace } from '../../src/council/session-reset.js';
import {
  ResetCancelledError,
  MalformedResetSummaryError,
} from '../../src/council/session-reset-errors.js';

describe('awaitResetRace helper', () => {
  it('aborted signal + APIUserAbortError reject → ResetCancelledError (R8 / round-1 P1-3)', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new ResetCancelledError('user'));

    const sdkErr = new Error('Request was aborted');
    Object.defineProperty(sdkErr, 'constructor', { value: { name: 'APIUserAbortError' } });
    sdkErr.name = 'APIUserAbortError';

    const summaryPromise = Promise.reject(sdkErr);
    const racePromise = new Promise<never>(() => {}); // never settles — force summaryPromise win

    await expect(
      awaitResetRace(summaryPromise, racePromise, ctrl.signal),
    ).rejects.toBeInstanceOf(ResetCancelledError);
  });

  it('aborted signal + APIUserAbortError reject → reason "user"', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new ResetCancelledError('user'));
    const sdkErr = new Error('aborted');
    sdkErr.name = 'APIUserAbortError';
    await expect(
      awaitResetRace(Promise.reject(sdkErr), new Promise<never>(() => {}), ctrl.signal),
    ).rejects.toMatchObject({ reason: 'user' });
  });

  it('aborted signal + non-abort reject → ResetCancelledError (round-2 P1-r2-1 broadening)', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new ResetCancelledError('user'));

    // Stand-in for any non-abort error class (e.g. provider 429, network blip).
    // Round-1 narrow catch (`isAbortError && aborted`) would rethrow this;
    // round-2 broadened catch (`signal.aborted` alone) reclassifies.
    const nonAbortErr = new MalformedResetSummaryError(['decisions']);

    await expect(
      awaitResetRace(Promise.reject(nonAbortErr), new Promise<never>(() => {}), ctrl.signal),
    ).rejects.toBeInstanceOf(ResetCancelledError);

    await expect(
      awaitResetRace(Promise.reject(nonAbortErr), new Promise<never>(() => {}), ctrl.signal),
    ).rejects.not.toBeInstanceOf(MalformedResetSummaryError);
  });

  it('NON-aborted signal + validation reject → original error preserved (regression guard)', async () => {
    const ctrl = new AbortController(); // NOT aborted

    const validationErr = new MalformedResetSummaryError(['decisions']);

    await expect(
      awaitResetRace(Promise.reject(validationErr), new Promise<never>(() => {}), ctrl.signal),
    ).rejects.toBeInstanceOf(MalformedResetSummaryError);
  });
});
