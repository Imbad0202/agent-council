import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GatewayRouter } from '../../src/gateway/router.js';
import { EventBus } from '../../src/events/bus.js';
import type { CouncilConfig, CouncilMessage } from '../../src/types.js';

function makeConfig(overrides?: Partial<CouncilConfig>): CouncilConfig {
  return {
    gateway: {
      thinkingWindowMs: 10,
      randomDelayMs: [0, 10],
      maxInterAgentRounds: 3,
      contextWindowTurns: 10,
      sessionMaxTurns: 20,
    },
    antiSycophancy: {
      disagreementThreshold: 0.2,
      consecutiveLowRounds: 3,
      challengeAngles: ['cost', 'risk'],
    },
    roles: {
      default2Agents: ['advocate', 'critic'],
      topicOverrides: {},
    },
    ...overrides,
  };
}

function makeMessage(content: string, threadId?: number): CouncilMessage {
  return {
    id: `msg-${Date.now()}`,
    role: 'human',
    content,
    timestamp: Date.now(),
    threadId,
  };
}

describe('GatewayRouter', () => {
  let bus: EventBus;
  let sendFn: ReturnType<typeof vi.fn>;
  let router: GatewayRouter;

  beforeEach(() => {
    bus = new EventBus();
    sendFn = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    router?.reset();
  });

  it('emits message.received on handleHumanMessage', () => {
    const config = makeConfig();
    router = new GatewayRouter(bus, sendFn, config);

    const received: Array<{ message: CouncilMessage; threadId: number }> = [];
    bus.on('message.received', (payload) => {
      received.push(payload);
    });

    const msg = makeMessage('What architecture should we use?', 42);
    router.handleHumanMessage(msg);

    expect(received).toHaveLength(1);
    expect(received[0].message).toBe(msg);
    expect(received[0].threadId).toBe(42);
  });

  it('emits session.ending on end keyword', () => {
    const config = makeConfig({
      memory: {
        dbPath: ':memory:',
        sessionTimeoutMs: 60000,
        endKeywords: ['結束', 'end session'],
        archiveThreshold: 100,
        archiveBottomPercent: 0.2,
        consolidationThreshold: 3,
      },
    });
    router = new GatewayRouter(bus, sendFn, config);

    const endings: Array<{ threadId: number; trigger: string }> = [];
    bus.on('session.ending', (payload) => {
      endings.push(payload);
    });

    const received: unknown[] = [];
    bus.on('message.received', (payload) => {
      received.push(payload);
    });

    const msg = makeMessage('好的，結束吧', 10);
    router.handleHumanMessage(msg);

    expect(endings).toHaveLength(1);
    expect(endings[0].threadId).toBe(10);
    expect(endings[0].trigger).toBe('keyword');
    // Should NOT emit message.received
    expect(received).toHaveLength(0);
  });

  it('sends facilitator messages to Telegram', async () => {
    const config = makeConfig();
    router = new GatewayRouter(bus, sendFn, config);

    bus.emit('facilitator.intervened', {
      threadId: 5,
      action: 'steer',
      content: 'Let us refocus on the architecture question.',
    });

    // Allow async handler to complete
    await new Promise((r) => setTimeout(r, 10));

    expect(sendFn).toHaveBeenCalledWith(
      'facilitator',
      'Let us refocus on the architecture question.',
      5,
    );
  });

  it('cleans up session on session.ended', () => {
    const config = makeConfig({
      memory: {
        dbPath: ':memory:',
        sessionTimeoutMs: 60000,
        endKeywords: ['結束'],
        archiveThreshold: 100,
        archiveBottomPercent: 0.2,
        consolidationThreshold: 3,
      },
    });
    router = new GatewayRouter(bus, sendFn, config);

    // Send a message to create a session timer
    const msg = makeMessage('Hello', 7);
    router.handleHumanMessage(msg);

    // End the session
    bus.emit('session.ended', { threadId: 7, topic: 'test', outcome: 'decision' });

    // Sending another message after cleanup should not crash
    const msg2 = makeMessage('After cleanup', 7);
    router.handleHumanMessage(msg2);

    // Verify message.received is still emitted (session was cleaned up, not blocked)
    const received: unknown[] = [];
    bus.on('message.received', (payload) => {
      received.push(payload);
    });

    const msg3 = makeMessage('Third message', 7);
    router.handleHumanMessage(msg3);
    expect(received).toHaveLength(1);
  });

  it('defaults threadId to 0 when not provided', () => {
    const config = makeConfig();
    router = new GatewayRouter(bus, sendFn, config);

    const received: Array<{ threadId: number }> = [];
    bus.on('message.received', (payload) => {
      received.push(payload);
    });

    const msg = makeMessage('No thread');
    router.handleHumanMessage(msg);

    expect(received[0].threadId).toBe(0);
  });

  it('reset clears all session timers', () => {
    const config = makeConfig({
      memory: {
        dbPath: ':memory:',
        sessionTimeoutMs: 60000,
        endKeywords: ['結束'],
        archiveThreshold: 100,
        archiveBottomPercent: 0.2,
        consolidationThreshold: 3,
      },
    });
    router = new GatewayRouter(bus, sendFn, config);

    // Create timers for multiple threads
    router.handleHumanMessage(makeMessage('Hello', 1));
    router.handleHumanMessage(makeMessage('Hello', 2));
    router.handleHumanMessage(makeMessage('Hello', 3));

    // Reset should not throw
    router.reset();
  });
});
