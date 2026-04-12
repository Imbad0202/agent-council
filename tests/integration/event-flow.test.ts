import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../../src/events/bus.js';
import { IntentGate } from '../../src/council/intent-gate.js';
import { GatewayRouter } from '../../src/gateway/router.js';
import type { CouncilConfig, CouncilMessage, LLMProvider } from '../../src/types.js';

const mockProvider: LLMProvider = {
  name: 'mock',
  chat: vi.fn().mockResolvedValue({ content: 'mock', tokensUsed: { input: 10, output: 20 } }),
  summarize: vi.fn().mockResolvedValue('summary'),
  estimateTokens: vi.fn().mockReturnValue(100),
};

const config: CouncilConfig = {
  gateway: { thinkingWindowMs: 0, randomDelayMs: [0, 0], maxInterAgentRounds: 1, contextWindowTurns: 10, sessionMaxTurns: 20 },
  antiSycophancy: { disagreementThreshold: 0.2, consecutiveLowRounds: 3, challengeAngles: ['cost'] },
  roles: { default2Agents: ['advocate', 'critic'], topicOverrides: {} },
  memory: { dbPath: ':memory:', sessionTimeoutMs: 600000, endKeywords: ['結束', 'done'], archiveThreshold: 30, archiveBottomPercent: 20, consolidationThreshold: 5 },
};

describe('Event Flow Integration', () => {
  let bus: EventBus;
  const sendFn = vi.fn();

  beforeEach(() => {
    bus = new EventBus();
    vi.clearAllMocks();
  });

  it('message.received → intent.classified flows correctly for implementation intent', async () => {
    const router = new GatewayRouter(bus, sendFn, config);
    const gate = new IntentGate(bus, mockProvider);
    const handler = vi.fn();
    bus.on('intent.classified', handler);

    router.handleHumanMessage({ id: 'msg-1', role: 'human', content: '幫我實作 retry logic', timestamp: Date.now(), threadId: 1 });

    await vi.waitFor(() => expect(handler).toHaveBeenCalled(), { timeout: 5000 });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ intent: 'implementation', threadId: 1 }));
  });

  it('end keyword triggers session.ending, not message.received', () => {
    const router = new GatewayRouter(bus, sendFn, config);
    const gate = new IntentGate(bus, mockProvider);
    const receivedHandler = vi.fn();
    const endingHandler = vi.fn();
    bus.on('message.received', receivedHandler);
    bus.on('session.ending', endingHandler);

    router.handleHumanMessage({ id: 'msg-1', role: 'human', content: '結束', timestamp: Date.now(), threadId: 1 });

    expect(endingHandler).toHaveBeenCalledWith(expect.objectContaining({ threadId: 1, trigger: 'keyword' }));
    expect(receivedHandler).not.toHaveBeenCalled();
  });

  it('facilitator.intervened event reaches sendFn', async () => {
    const router = new GatewayRouter(bus, sendFn, config);

    bus.emit('facilitator.intervened', { threadId: 1, action: 'summarize', content: '目前共識是 X' });

    await vi.waitFor(() => expect(sendFn).toHaveBeenCalled());
    expect(sendFn).toHaveBeenCalledWith('facilitator', '目前共識是 X', 1);
  });

  it('investigation intent classified from keywords', async () => {
    const router = new GatewayRouter(bus, sendFn, config);
    const gate = new IntentGate(bus, mockProvider);
    const handler = vi.fn();
    bus.on('intent.classified', handler);

    router.handleHumanMessage({ id: 'msg-1', role: 'human', content: '為什麼 CI 壞了？', timestamp: Date.now(), threadId: 2 });

    await vi.waitFor(() => expect(handler).toHaveBeenCalled(), { timeout: 5000 });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ intent: 'investigation' }));
  });
});
