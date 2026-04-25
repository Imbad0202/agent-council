import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { DeliberationHandler } from '../../src/council/deliberation.js';
import { EventBus } from '../../src/events/bus.js';
import type { EventMap } from '../../src/events/bus.js';
import type { AgentWorker } from '../../src/worker/agent-worker.js';
import type { CouncilMessage, ProviderResponse } from '../../src/types.js';
import type { AgentTier } from '../../src/types.js';
import { makeWorker, minConfig, makeMessage } from './helpers.js';

describe('DeliberationHandler', () => {
  let bus: EventBus;
  let workers: AgentWorker[];
  let sendFn: ReturnType<typeof vi.fn>;
  let handler: DeliberationHandler;

  beforeEach(() => {
    bus = new EventBus();
    workers = [makeWorker('agent-a', 'Agent A'), makeWorker('agent-b', 'Agent B')];
    sendFn = vi.fn().mockResolvedValue(undefined);
    handler = new DeliberationHandler(bus, workers, minConfig, sendFn);
  });

  it('starts deliberation on intent.classified and emits agent.responded for each agent', async () => {
    const responded: EventMap['agent.responded'][] = [];
    bus.on('agent.responded', (payload) => responded.push(payload));

    const message = makeMessage('What is the best approach for microservices?');

    // Emit intent.classified to trigger deliberation
    const done = new Promise<void>((resolve) => {
      bus.on('deliberation.ended', () => resolve());
    });

    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'medium',
      threadId: 1,
      message,
    });

    await done;

    expect(responded).toHaveLength(2);
    expect(responded[0].agentId).toBe('agent-a');
    expect(responded[1].agentId).toBe('agent-b');
    expect(responded[0].threadId).toBe(1);
    expect(responded[1].threadId).toBe(1);
  });

  it('emits deliberation.started before agent responses', async () => {
    const events: string[] = [];

    bus.on('deliberation.started', () => events.push('started'));
    bus.on('agent.responded', () => events.push('responded'));
    bus.on('deliberation.ended', () => events.push('ended'));

    const message = makeMessage('How should we handle authentication?');

    const done = new Promise<void>((resolve) => {
      bus.on('deliberation.ended', () => resolve());
    });

    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'medium',
      threadId: 1,
      message,
    });

    await done;

    expect(events[0]).toBe('started');
    expect(events.filter((e) => e === 'responded')).toHaveLength(2);
    // started must come first
    expect(events.indexOf('started')).toBeLessThan(events.indexOf('responded'));
  });

  it('emits deliberation.ended after all responses with correct intent', async () => {
    let endedPayload: EventMap['deliberation.ended'] | null = null;

    const done = new Promise<void>((resolve) => {
      bus.on('deliberation.ended', (payload) => {
        endedPayload = payload;
        resolve();
      });
    });

    const message = makeMessage('Discuss caching strategies');

    bus.emit('intent.classified', {
      intent: 'investigation',
      complexity: 'high',
      threadId: 42,
      message,
    });

    await done;

    expect(endedPayload).not.toBeNull();
    expect(endedPayload!.threadId).toBe(42);
    expect(endedPayload!.intent).toBe('investigation');
    expect(endedPayload!.conclusion).toBeTruthy();
  });

  it('skips deliberation for meta intent', async () => {
    let startedEmitted = false;
    bus.on('deliberation.started', () => { startedEmitted = true; });

    const message = makeMessage('結束');

    bus.emit('intent.classified', {
      intent: 'meta',
      complexity: 'low',
      threadId: 1,
      message,
    });

    // Give a tick for any async handler to run
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(startedEmitted).toBe(false);
    // Workers should not have been called
    expect((workers[0].respond as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((workers[1].respond as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('sends responses via sendFn', async () => {
    const done = new Promise<void>((resolve) => {
      bus.on('deliberation.ended', () => resolve());
    });

    const message = makeMessage('Test sending');

    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'low',
      threadId: 5,
      message,
    });

    await done;

    // sendFn called once per non-skipped response
    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(sendFn).toHaveBeenCalledWith('agent-a', 'Response from agent-a', 5);
    expect(sendFn).toHaveBeenCalledWith('agent-b', 'Response from agent-b', 5);
  });

  it('passes complexity to worker.respond', async () => {
    const done = new Promise<void>((resolve) => {
      bus.on('deliberation.ended', () => resolve());
    });

    const message = makeMessage('Complex question about distributed systems');

    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'high',
      threadId: 1,
      message,
    });

    await done;

    for (const worker of workers) {
      const respondMock = worker.respond as ReturnType<typeof vi.fn>;
      expect(respondMock).toHaveBeenCalledTimes(1);
      // 4th argument should be complexity
      expect(respondMock.mock.calls[0][3]).toBe('high');
    }
  });

  it('stores pending pattern injection from pattern.detected', async () => {
    // First, run a deliberation to establish a session
    const done1 = new Promise<void>((resolve) => {
      bus.on('deliberation.ended', () => resolve());
    });

    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'low',
      threadId: 10,
      message: makeMessage('First message', 10),
    });
    await done1;

    // Emit pattern.detected for agent-a
    bus.emit('pattern.detected', {
      threadId: 10,
      pattern: 'mirror',
      targetAgent: 'agent-a',
    });

    // Now run another deliberation — agent-a should receive the injection
    const done2 = new Promise<void>((resolve) => {
      bus.on('deliberation.ended', () => resolve());
    });

    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'low',
      threadId: 10,
      message: makeMessage('Second message', 10),
    });
    await done2;

    const respondMock = workers[0].respond as ReturnType<typeof vi.fn>;
    // Second call — challengePrompt should contain pattern injection text
    const secondCallArgs = respondMock.mock.calls[1];
    const challengePrompt = secondCallArgs[2] as string;
    // The injection prompt for 'mirror' pattern should be present
    expect(challengePrompt).toBeTruthy();
  });

  it('adds facilitator message to history via inline intervention path', async () => {
    // v0.5.2 P1-B option C: facilitator messages now enter currentMessages
    // ONLY through the inline path in runDeliberation, not via the
    // facilitator.intervened listener. The listener was the legacy race
    // source; this test validates the new contract by injecting a
    // facilitatorIntervention hook that returns a steer decision after the
    // first agent responds, then verifying agent-b receives that
    // facilitator message in its history on the next call.
    const localBus = new EventBus();
    const localWorkers = [
      makeWorker('agent-a', 'Agent A'),
      makeWorker('agent-b', 'Agent B'),
    ];
    const localSend = vi.fn().mockResolvedValue(undefined);

    let evalCallCount = 0;
    const interventionHook = {
      recordAgentResponse: vi.fn(),
      evaluateIntervention: vi.fn(async () => {
        evalCallCount += 1;
        // Only intervene after the FIRST agent (so agent-b sees the
        // facilitator message in its turn history).
        if (evalCallCount === 1) {
          return {
            action: 'steer' as const,
            content: 'Let us focus on the practical implications.',
          };
        }
        return null;
      }),
    };

    new DeliberationHandler(localBus, localWorkers, minConfig, localSend, {
      facilitatorIntervention: interventionHook,
    });

    const done = new Promise<void>((resolve) => {
      localBus.on('deliberation.ended', () => resolve());
    });
    localBus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'low',
      threadId: 20,
      message: makeMessage('Initial topic', 20),
    });
    await done;

    // Agent-b's history (mock.calls[0] for agent-b worker) should include
    // the facilitator message pushed inline after agent-a's response.
    const respondMockB = localWorkers[1].respond as ReturnType<typeof vi.fn>;
    const historyArg = respondMockB.mock.calls[0][0] as CouncilMessage[];
    const facilitatorMsg = historyArg.find((m) => m.agentId === 'facilitator');
    expect(facilitatorMsg).toBeDefined();
    expect(facilitatorMsg!.content).toBe('Let us focus on the practical implications.');
  });

  it('facilitator.intervened listener no longer pushes to currentMessages (race fix)', async () => {
    // v0.5.2 P1-B option C: external bus.emit('facilitator.intervened')
    // must NOT mutate session state. This test pins the new contract.
    const done1 = new Promise<void>((resolve) => {
      bus.on('deliberation.ended', () => resolve());
    });
    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'low',
      threadId: 21,
      message: makeMessage('Initial topic', 21),
    });
    await done1;

    // External emit — pre-fix this would have pushed into currentMessages
    // and contaminated the next round. Post-fix it's only consumed by
    // router-level broadcast.
    bus.emit('facilitator.intervened', {
      threadId: 21,
      action: 'steer',
      content: 'Late ghost message — must NOT enter currentMessages.',
    });
    await new Promise((r) => setTimeout(r, 10));

    const done2 = new Promise<void>((resolve) => {
      bus.on('deliberation.ended', () => resolve());
    });
    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'low',
      threadId: 21,
      message: makeMessage('Follow-up', 21),
    });
    await done2;

    const respondMock = workers[0].respond as ReturnType<typeof vi.fn>;
    const historyArg = respondMock.mock.calls[1][0] as CouncilMessage[];
    const ghost = historyArg.find((m) => m.content?.includes('Late ghost message'));
    expect(ghost).toBeUndefined();
  });
});

describe('DeliberationHandler — blind-review turn recording', () => {
  function makeWorkerWithTier(id: string, name: string, tier: AgentTier, model: string): AgentWorker {
    return {
      id,
      name,
      respond: vi.fn<[], Promise<ProviderResponse>>().mockResolvedValue({
        content: `Response from ${id}`,
        confidence: 0.8,
        references: [],
        tokensUsed: { input: 100, output: 50 },
        tierUsed: tier,
        modelUsed: model,
      }),
    } as unknown as AgentWorker;
  }

  it('records tierUsed + modelUsed into the blind-review store after each turn', async () => {
    const bus = new EventBus();
    const workers = [
      makeWorkerWithTier('agent-a', 'Agent A', 'high', 'claude-opus-4-7'),
      makeWorkerWithTier('agent-b', 'Agent B', 'low', 'claude-sonnet-4-6'),
    ];
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const sendKeyboardFn = vi.fn().mockResolvedValue(undefined);
    const handler = new DeliberationHandler(bus, workers, minConfig, sendFn, {
      sendKeyboardFn,
    });

    const store = handler.getBlindReviewStore();
    const threadId = 99;

    const message: CouncilMessage = {
      id: 'msg-blind-1',
      role: 'human',
      content: 'Evaluate this proposal',
      timestamp: Date.now(),
      threadId,
      blindReview: true,
    };

    const done = new Promise<void>((resolve) => {
      bus.on('deliberation.ended', () => resolve());
    });

    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'medium',
      threadId,
      message,
    });

    await done;

    const turnA = store.getLatestTurnFor(threadId, 'agent-a');
    expect(turnA).not.toBeNull();
    expect(turnA!.tier).toBe('high');
    expect(turnA!.model).toBe('claude-opus-4-7');

    const turnB = store.getLatestTurnFor(threadId, 'agent-b');
    expect(turnB).not.toBeNull();
    expect(turnB!.tier).toBe('low');
    expect(turnB!.model).toBe('claude-sonnet-4-6');
  });

  // Round-11 codex finding [P2]: BlindReviewStore.create() populates the
  // store synchronously, but session.blindReviewSessionId is only set when
  // the 'blind-review.started' event listener fires — which only happens
  // *after* sendKeyboardFn awaits successfully. If sendKeyboardFn rejects
  // (Telegram rate-limit, network blip, bot down), the store still holds
  // a pending session (so a fresh /blindreview is rejected), but the
  // per-thread guard reads null (so /councilreset is wrongly allowed).
  // Fix: set the guard immediately after store.create() succeeds; on
  // sendKeyboardFn failure roll back both (store.delete + clear the guard).
  it('clears blindReviewSessionId guard and store entry when sendKeyboardFn rejects', async () => {
    const bus = new EventBus();
    const workers = [
      makeWorkerWithTier('agent-a', 'Agent A', 'high', 'claude-opus-4-7'),
      makeWorkerWithTier('agent-b', 'Agent B', 'low', 'claude-sonnet-4-6'),
    ];
    const sendFn = vi.fn().mockResolvedValue(undefined);
    // Reject the keyboard send to simulate Telegram failure mid-round.
    const sendKeyboardFn = vi.fn().mockRejectedValue(new Error('telegram rate limit'));
    const handler = new DeliberationHandler(bus, workers, minConfig, sendFn, {
      sendKeyboardFn,
    });

    const store = handler.getBlindReviewStore();
    const threadId = 101;

    const message: CouncilMessage = {
      id: 'msg-blind-fail',
      role: 'human',
      content: 'Evaluate again',
      timestamp: Date.now(),
      threadId,
      blindReview: true,
    };

    const done = new Promise<void>((resolve) => {
      bus.on('deliberation.ended', () => resolve());
    });

    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'medium',
      threadId,
      message,
    });

    await done;

    // After the failed sendKeyboard:
    //  - the per-thread guard MUST be null (otherwise /councilreset stays
    //    wrongly blocked while the store also wrongly allows the path)
    //  - the store entry MUST be cleared (otherwise a retry of /blindreview
    //    would be rejected as "pending session exists")
    expect(handler.getBlindReviewSessionId(threadId)).toBeNull();
    expect(store.get(threadId)).toBeUndefined();
  });

  // Round-12 codex finding [P1-A]: round-11's blind-review fix only caught
  // sendKeyboardFn failures. Any earlier await in the round (agent respond,
  // sendFn, debrief broadcast, ...) throwing would exit runDeliberation
  // with the store entry and per-thread guard still populated, wedging
  // both /blindreview ("pending session exists") and /councilreset
  // ("blind-review pending"). Fix: rollback in finally if the keyboard was
  // never successfully posted, regardless of which await blew up.
  it('rolls back blind-review state when an agent respond() throws before keyboard send', async () => {
    const bus = new EventBus();
    const workers = [
      makeWorkerWithTier('agent-a', 'Agent A', 'high', 'claude-opus-4-7'),
      makeWorkerWithTier('agent-b', 'Agent B', 'low', 'claude-sonnet-4-6'),
    ];
    // agent-a's respond throws — this happens BEFORE the sendKeyboardFn
    // catch block, so the round-11 fix doesn't cover it.
    (workers[0].respond as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('provider 503'),
    );
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const sendKeyboardFn = vi.fn().mockResolvedValue(undefined);
    const handler = new DeliberationHandler(bus, workers, minConfig, sendFn, {
      sendKeyboardFn,
    });

    const store = handler.getBlindReviewStore();
    const threadId = 102;

    const message: CouncilMessage = {
      id: 'msg-blind-throw',
      role: 'human',
      content: 'Evaluate this',
      timestamp: Date.now(),
      threadId,
      blindReview: true,
    };

    // intent.classified → runDeliberation is fire-and-forget (the listener
    // doesn't await), so an agent throw becomes an unhandled rejection.
    // Swallow it just for this test — the production behaviour is the same;
    // observability of pre-existing unhandled rejections is out of scope for
    // round-12 P1-A.
    const swallowReject = (err: Error): void => {
      if (err.message !== 'provider 503') throw err;
    };
    process.on('unhandledRejection', swallowReject as never);

    const finished = new Promise<void>((resolve) => {
      bus.on('deliberation.ended', () => resolve());
      // Fallback: runDeliberation aborts before deliberation.ended on this
      // path, so a short timeout lets the finally block settle.
      setTimeout(resolve, 200);
    });

    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'medium',
      threadId,
      message,
    });

    await finished;
    process.off('unhandledRejection', swallowReject as never);

    // Both must be cleared so the user can retry /blindreview AND
    // /councilreset is no longer wrongly blocked.
    expect(handler.getBlindReviewSessionId(threadId)).toBeNull();
    expect(store.get(threadId)).toBeUndefined();
    // sendKeyboardFn was never reached — the round aborted earlier.
    expect(sendKeyboardFn).not.toHaveBeenCalled();
  });

  it('does NOT record turns when blindReview is false', async () => {
    const bus = new EventBus();
    const workers = [
      makeWorkerWithTier('agent-a', 'Agent A', 'medium', 'claude-sonnet'),
      makeWorkerWithTier('agent-b', 'Agent B', 'medium', 'claude-sonnet'),
    ];
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const handler = new DeliberationHandler(bus, workers, minConfig, sendFn);

    const store = handler.getBlindReviewStore();
    const threadId = 100;

    const message: CouncilMessage = {
      id: 'msg-normal-1',
      role: 'human',
      content: 'Regular question',
      timestamp: Date.now(),
      threadId,
    };

    const done = new Promise<void>((resolve) => {
      bus.on('deliberation.ended', () => resolve());
    });

    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'medium',
      threadId,
      message,
    });

    await done;

    // No blind-review session was created, so store returns null
    expect(store.getLatestTurnFor(threadId, 'agent-a')).toBeNull();
    expect(store.getLatestTurnFor(threadId, 'agent-b')).toBeNull();
  });

  // Round-9 codex finding [P1]: round-7 added "reset refuses during
  // deliberation" but NOT the symmetric "deliberation refuses during reset".
  // If a user sends a message while /councilreset is waiting on the
  // facilitator summary call, runDeliberation would happily push it into the
  // current segment and the subsequent sealCurrentSegment would persist a
  // snapshot that no longer matches the sealed transcript.
  it('skips deliberation and notifies the user when a reset is in flight', async () => {
    const bus = new EventBus();
    const workers = [makeWorker('agent-a', 'Agent A'), makeWorker('agent-b', 'Agent B')];
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const handler = new DeliberationHandler(bus, workers, minConfig, sendFn);

    const threadId = 7;
    // Materialize the session, then flag reset-in-flight to simulate an
    // in-progress /councilreset waiting on the facilitator.
    handler.isResetInFlight(threadId);
    handler.setResetInFlight(threadId, true);

    const agentResponded: EventMap['agent.responded'][] = [];
    bus.on('agent.responded', (payload) => agentResponded.push(payload));

    const message = makeMessage('user message during reset', threadId);

    // Give the handler a moment to run and emit. Don't wait on
    // deliberation.ended — the whole point is it should NOT fire.
    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'medium',
      threadId,
      message,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(agentResponded).toHaveLength(0);
    for (const w of workers) {
      expect(w.respond).not.toHaveBeenCalled();
    }
    // User gets a clear reply that the message was skipped.
    const replies = sendFn.mock.calls.map((call) => String(call[1] ?? ''));
    expect(replies.some((r) => /reset/i.test(r))).toBe(true);
    // Current segment should NOT contain the dropped message.
    expect(handler.getCurrentSegmentMessages(threadId)).toHaveLength(0);
  });
});
