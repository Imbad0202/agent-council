import { describe, it, expect, vi, afterEach } from 'vitest';
import { DeliberationHandler } from '../../src/council/deliberation.js';
import { EventBus } from '../../src/events/bus.js';
import type { AgentWorker } from '../../src/worker/agent-worker.js';
import type { CouncilConfig, CouncilMessage, ProviderResponse } from '../../src/types.js';
import { PvgRotateStore } from '../../src/council/pvg-rotate-store.js';

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

describe('DeliberationHandler — pvg-rotate rotation mode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('plants biased-prover role, stores debrief, sends keyboard, suppresses system-debrief broadcast', async () => {
    // Force Math.random → 0.25 → index 1 → biased-prover
    vi.spyOn(Math, 'random').mockReturnValue(0.25);

    const bus = new EventBus();
    const pvgRotateStore = new PvgRotateStore();

    const workerA: AgentWorker = {
      id: 'agent-a',
      name: 'Agent A',
      respond: vi.fn().mockImplementation((_history: CouncilMessage[], role: string) => {
        if (role === 'biased-prover') {
          return Promise.resolve({
            content: 'Biased answer\n<<<BIASED-PROVER:anchoring|anchored to first figure>>>',
            confidence: 0.8,
            references: [],
            tokensUsed: { input: 10, output: 20 },
          });
        }
        return Promise.resolve({
          content: 'Regular answer from agent-a',
          confidence: 0.8,
          references: [],
          tokensUsed: { input: 10, output: 20 },
        });
      }),
    } as unknown as AgentWorker;

    const workerB: AgentWorker = {
      id: 'agent-b',
      name: 'Agent B',
      respond: vi.fn().mockResolvedValue({
        content: 'Critic answer from agent-b',
        confidence: 0.8,
        references: [],
        tokensUsed: { input: 10, output: 20 },
      }),
    } as unknown as AgentWorker;

    const sendFn = vi.fn().mockResolvedValue(undefined);
    const sendKeyboardFn = vi.fn().mockResolvedValue(undefined);
    const threadId = 200;

    new DeliberationHandler(bus, [workerA, workerB], minConfig, sendFn, {
      sendKeyboardFn,
      pvgRotateStore,
    });

    const message: CouncilMessage = {
      id: 'msg-pvg-1',
      role: 'human',
      content: 'Test pvg rotate question',
      timestamp: Date.now(),
      threadId,
      pvgRotate: true,
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

    const session = pvgRotateStore.get(threadId);
    expect(session).toBeDefined();
    expect(session!.plantedRole).toBe('biased-prover');

    expect(session!.plantedDebrief).toBeDefined();
    expect(session!.plantedDebrief!.role).toBe('biased-prover');

    expect(sendKeyboardFn).toHaveBeenCalledTimes(1);
    const keyboard = sendKeyboardFn.mock.calls[0][2] as import('grammy').InlineKeyboard;
    const inlineKeyboard = (keyboard as unknown as { inline_keyboard: Array<Array<unknown>> }).inline_keyboard;
    const totalButtons = inlineKeyboard.reduce((acc: number, row: unknown[]) => acc + row.length, 0);
    expect(totalButtons).toBe(4);

    const systemDebriefCalls = sendFn.mock.calls.filter((c: unknown[]) => c[0] === 'system-debrief');
    expect(systemDebriefCalls).toHaveLength(0);

    const respondBCalls = (workerB.respond as ReturnType<typeof vi.fn>).mock.calls;
    expect(respondBCalls[0][1]).toBe('critic');
  });

  it('does NOT activate rotation when pvgRotate is not set — existing adversarial path unchanged', async () => {
    const bus = new EventBus();
    const pvgRotateStore = new PvgRotateStore();

    const sendFn = vi.fn().mockResolvedValue(undefined);
    const sendKeyboardFn = vi.fn().mockResolvedValue(undefined);
    const threadId = 201;

    new DeliberationHandler(
      bus,
      [makeWorker('agent-a', 'Agent A'), makeWorker('agent-b', 'Agent B')],
      minConfig,
      sendFn,
      { sendKeyboardFn, pvgRotateStore },
    );

    const message: CouncilMessage = {
      id: 'msg-no-pvg',
      role: 'human',
      content: 'Normal question',
      timestamp: Date.now(),
      threadId,
      adversarialMode: 'biased',
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

    expect(pvgRotateStore.get(threadId)).toBeUndefined();

    const systemDebriefCalls = sendFn.mock.calls.filter((c: unknown[]) => c[0] === 'system-debrief');
    expect(systemDebriefCalls).toHaveLength(1);
  });
});
