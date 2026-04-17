import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { DeliberationHandler } from '../../src/council/deliberation.js';
import { EventBus } from '../../src/events/bus.js';
import type { EventMap } from '../../src/events/bus.js';
import type { AgentWorker } from '../../src/worker/agent-worker.js';
import type { CouncilConfig, CouncilMessage, ProviderResponse } from '../../src/types.js';
import type { AgentTier } from '../../src/types.js';

function makeWorker(id: string, name: string): AgentWorker {
  return {
    id,
    name,
    respond: vi.fn<[], Promise<ProviderResponse>>().mockResolvedValue({
      content: `Response from ${id}`,
      confidence: 0.8,
      references: [],
      tokensUsed: { input: 100, output: 50 },
    }),
  } as unknown as AgentWorker;
}

const minConfig: CouncilConfig = {
  gateway: {
    thinkingWindowMs: 0,
    randomDelayMs: [0, 0],
    maxInterAgentRounds: 3,
    contextWindowTurns: 10,
    sessionMaxTurns: 20,
  },
  antiSycophancy: {
    disagreementThreshold: 0.2,
    consecutiveLowRounds: 3,
    challengeAngles: ['cost', 'risk', 'alternatives'],
  },
  roles: {
    default2Agents: ['advocate', 'critic'],
    topicOverrides: {},
  },
};

function makeMessage(content: string, threadId = 1): CouncilMessage {
  return {
    id: `msg-${Date.now()}`,
    role: 'human',
    content,
    timestamp: Date.now(),
    threadId,
  };
}

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

  it('adds facilitator message to history from facilitator.intervened', async () => {
    // Run a deliberation first to create session
    const done1 = new Promise<void>((resolve) => {
      bus.on('deliberation.ended', () => resolve());
    });

    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'low',
      threadId: 20,
      message: makeMessage('Initial topic', 20),
    });
    await done1;

    // Emit facilitator.intervened
    bus.emit('facilitator.intervened', {
      threadId: 20,
      action: 'steer',
      content: 'Let us focus on the practical implications.',
    });

    // Give a tick for the handler to process
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Run another deliberation — history should include facilitator message
    const done2 = new Promise<void>((resolve) => {
      bus.on('deliberation.ended', () => resolve());
    });

    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'low',
      threadId: 20,
      message: makeMessage('Follow-up question', 20),
    });
    await done2;

    // Check that workers received history containing the facilitator message
    const respondMock = workers[0].respond as ReturnType<typeof vi.fn>;
    const historyArg = respondMock.mock.calls[1][0] as CouncilMessage[];
    const facilitatorMsg = historyArg.find((m) => m.agentId === 'facilitator');
    expect(facilitatorMsg).toBeDefined();
    expect(facilitatorMsg!.content).toBe('Let us focus on the practical implications.');
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
      makeWorkerWithTier('agent-a', 'Agent A', 'high', 'claude-3-5-sonnet'),
      makeWorkerWithTier('agent-b', 'Agent B', 'low', 'claude-haiku-3'),
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
    expect(turnA!.model).toBe('claude-3-5-sonnet');

    const turnB = store.getLatestTurnFor(threadId, 'agent-b');
    expect(turnB).not.toBeNull();
    expect(turnB!.tier).toBe('low');
    expect(turnB!.model).toBe('claude-haiku-3');
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
});
