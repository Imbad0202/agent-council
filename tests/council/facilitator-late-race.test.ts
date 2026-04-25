import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FacilitatorAgent } from '../../src/council/facilitator.js';
import { EventBus } from '../../src/events/bus.js';
import type { EventMap } from '../../src/events/bus.js';
import type { AgentWorker } from '../../src/worker/agent-worker.js';
import type { ProviderResponse } from '../../src/types.js';

// v0.5.2 P1-B regression test for the late `facilitator.intervened` race
// deferred at round-12 of the v0.5.1 review cycle.
//
// Pre-fix race shape:
//   1. runDeliberation emits agent.responded
//   2. FacilitatorAgent's agent.responded LISTENER fires evaluateIntervention,
//      which starts an async LLM call (fire-and-forget — bus.emit does not
//      await async listeners)
//   3. runDeliberation finishes, sets deliberationInFlight = false,
//      emits deliberation.ended
//   4. /councilreset passes the in-flight guard and seals the segment
//   5. The facilitator LLM finally returns and emits facilitator.intervened
//   6. The Deliberation listener pushes a facilitator message into
//      currentMessages — but the segment has already been sealed.
//
// Post-fix:
//   - FacilitatorAgent no longer subscribes to agent.responded.
//   - DeliberationHandler.runDeliberation calls
//     facilitator.recordAgentResponse + await facilitator.evaluateIntervention
//     INLINE after each agent.responded emit. The await keeps the work
//     inside the deliberationInFlight window so reset blocks until it
//     completes.
//
// This test reproduces the legacy race by simulating a CALLER that doesn't
// await (the pre-fix listener path) vs the new caller that does. The
// FacilitatorAgent class itself no longer fires the LLM call as a side
// effect — public methods are the only entry point.

function makeControllableWorker(): {
  worker: AgentWorker;
  release: (responseContent: string) => void;
  callStarted: Promise<void>;
} {
  let resolveResponse: ((r: ProviderResponse) => void) | null = null;
  let signalStarted: (() => void) | null = null;
  const callStarted = new Promise<void>((res) => {
    signalStarted = res;
  });

  const respond = vi.fn(async (): Promise<ProviderResponse> => {
    signalStarted?.();
    return new Promise<ProviderResponse>((res) => {
      resolveResponse = res;
    });
  });

  const worker = {
    id: 'facilitator',
    name: '主持人',
    respond,
  } as unknown as AgentWorker;

  return {
    worker,
    release: (content) =>
      resolveResponse?.({ content, tokensUsed: { input: 50, output: 30 } }),
    callStarted,
  };
}

describe('FacilitatorAgent — late intervened race (v0.5.2 P1-B)', () => {
  let bus: EventBus;
  let facilitator: FacilitatorAgent;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('evaluateIntervention RETURNS decision instead of emitting (option C contract)', async () => {
    // v0.5.2 P1-B option C: evaluateIntervention no longer emits
    // facilitator.intervened from inside the LLM callback. The caller
    // (DeliberationHandler) decides synchronously whether to push +
    // emit, which closes the timeout-leak race where a slow LLM could
    // emit AFTER deliberation.ended cleared the in-flight window.

    const { worker, release, callStarted } = makeControllableWorker();
    facilitator = new FacilitatorAgent(bus, worker);

    const interventionEvents: EventMap['facilitator.intervened'][] = [];
    bus.on('facilitator.intervened', (p) => interventionEvents.push(p));

    facilitator.recordAgentResponse(99, 'huahua', 'first');
    facilitator.recordAgentResponse(99, 'binbin', 'second');

    const resultPromise = facilitator.evaluateIntervention(99);
    await callStarted;
    release('{"action": "steer", "content": "inline steer", "target_agent": null}');
    const result = await resultPromise;

    // Decision is returned, not emitted from inside FacilitatorAgent.
    expect(result).toEqual({ action: 'steer', content: 'inline steer' });
    expect(interventionEvents).toHaveLength(0);
  });

  it('late LLM resolution after timeout swallow does NOT emit (race fully closed)', async () => {
    // Round-3 P1 regression test: even if the caller times out and stops
    // awaiting, evaluateIntervention's eventual completion must not
    // produce a facilitator.intervened event. Since option C moved the
    // emit into the caller, a "late" decision is just an unobserved
    // return value — the bus never sees it.

    const { worker, release, callStarted } = makeControllableWorker();
    facilitator = new FacilitatorAgent(bus, worker);

    const interventionEvents: EventMap['facilitator.intervened'][] = [];
    bus.on('facilitator.intervened', (p) => interventionEvents.push(p));

    facilitator.recordAgentResponse(50, 'huahua', 'first');
    facilitator.recordAgentResponse(50, 'binbin', 'second');

    // Caller starts the call but abandons it (simulating timeout swallow).
    const abandonedPromise = facilitator.evaluateIntervention(50);
    await callStarted;
    // Don't await abandonedPromise — caller "moved on".

    // Long after the round would have ended, the LLM finally resolves.
    release('{"action": "steer", "content": "late ghost", "target_agent": null}');
    await abandonedPromise; // let internal completion happen
    await new Promise((r) => setTimeout(r, 20));

    // No emit means no listener could push to a sealed segment.
    expect(interventionEvents).toHaveLength(0);
  });

  it('mid-round facilitator hang does NOT wedge the deliberation loop (round-2 P1)', async () => {
    // Codex round-2 P1: an unbounded facilitator call on the hot path could
    // wedge the round if the provider stalls. The handler installs a 30s
    // timeout per intervention call and swallows the rejection so the round
    // continues. This test injects a hanging facilitatorIntervention hook
    // and verifies deliberation.ended still fires.
    const { DeliberationHandler } = await import('../../src/council/deliberation.js');
    const { makeWorker, minConfig, makeMessage } = await import('./helpers.js');

    const workers = [makeWorker('agent-a', 'A'), makeWorker('agent-b', 'B')];
    const sendFn = vi.fn().mockResolvedValue(undefined);

    // Hook that hangs forever on every evaluateIntervention call. The
    // handler must time it out and proceed.
    const hangingHook = {
      recordAgentResponse: vi.fn(),
      evaluateIntervention: vi.fn(() => new Promise<void>(() => {})),
    };

    const localBus = new EventBus();
    new DeliberationHandler(localBus, workers, minConfig, sendFn, {
      facilitatorIntervention: hangingHook,
    });

    const ended = new Promise<void>((resolve) => {
      localBus.on('deliberation.ended', () => resolve());
    });

    // Suppress expected "facilitator intervention failed" console noise.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      localBus.emit('intent.classified', {
        intent: 'deliberation',
        complexity: 'medium',
        threadId: 11,
        message: makeMessage('hang test', 11),
      });

      // Advance past the timeout for each agent's intervention (2 × 30s).
      // advanceTimersByTimeAsync also runs queued microtasks between ticks.
      await vi.advanceTimersByTimeAsync(60_001);

      await ended;

      // The hook was called for both agents; both timed out.
      expect(hangingHook.recordAgentResponse).toHaveBeenCalledTimes(2);
      expect(hangingHook.evaluateIntervention).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      errSpy.mockRestore();
    }
  });

  it('synchronous throw from facilitator hook does NOT wedge the round (round-4 P3)', async () => {
    // Codex round-4 P3: hook calls were not wrapped in try/catch, so a
    // custom implementation that throws synchronously from
    // recordAgentResponse or from a non-async evaluateIntervention would
    // abort runDeliberation before the .catch on raceWithTimeout could
    // help. Caller must isolate hook failures.
    const { DeliberationHandler } = await import('../../src/council/deliberation.js');
    const { makeWorker, minConfig, makeMessage } = await import('./helpers.js');

    const workers = [makeWorker('agent-a', 'A'), makeWorker('agent-b', 'B')];
    const sendFn = vi.fn().mockResolvedValue(undefined);

    // Hook that throws synchronously from BOTH methods.
    const throwingHook = {
      recordAgentResponse: vi.fn(() => {
        throw new Error('record threw');
      }),
      evaluateIntervention: vi.fn(() => {
        throw new Error('evaluate threw');
      }),
    };

    const localBus = new EventBus();
    new DeliberationHandler(localBus, workers, minConfig, sendFn, {
      facilitatorIntervention: throwingHook,
    });

    const ended = new Promise<void>((resolve) => {
      localBus.on('deliberation.ended', () => resolve());
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      localBus.emit('intent.classified', {
        intent: 'deliberation',
        complexity: 'medium',
        threadId: 12,
        message: makeMessage('throw test', 12),
      });
      await ended;

      // Both agents ran despite both hook calls throwing on every agent.
      expect(throwingHook.recordAgentResponse).toHaveBeenCalledTimes(2);
      expect(throwingHook.evaluateIntervention).toHaveBeenCalledTimes(2);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('FacilitatorAgent no longer subscribes to agent.responded (no fire-and-forget LLM call)', async () => {
    // Pre-fix the constructor wired bus.on('agent.responded', ...) which
    // kicked off evaluateIntervention asynchronously. This test pins the
    // contract: emitting agent.responded must NOT trigger the worker.
    const { worker } = makeControllableWorker();
    facilitator = new FacilitatorAgent(bus, worker);

    bus.emit('deliberation.started', {
      threadId: 7,
      participants: ['huahua', 'binbin'],
      roles: {},
      structure: 'free',
      topic: 'no-listener',
    });
    await new Promise((r) => setTimeout(r, 5));

    bus.emit('agent.responded', {
      threadId: 7,
      agentId: 'huahua',
      response: { content: 'a', tokensUsed: { input: 1, output: 1 } },
      role: 'advocate',
      classification: 'opposition',
    });
    bus.emit('agent.responded', {
      threadId: 7,
      agentId: 'binbin',
      response: { content: 'b', tokensUsed: { input: 1, output: 1 } },
      role: 'critic',
      classification: 'agreement',
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(worker.respond as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});
