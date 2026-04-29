import { describe, it, expect, vi } from 'vitest';
import { DeliberationHandler } from '../../src/council/deliberation.js';
import { EventBus } from '../../src/events/bus.js';
import { makeWorker, minConfig, makeMessage } from './helpers.js';

describe('Facilitator intervention abort threading (v0.5.3 §5.1 site 5)', () => {
  it('Test I: timed-out intervention aborts underlying chat (signal fires)', async () => {
    const workers = [makeWorker('agent-a', 'A'), makeWorker('agent-b', 'B')];
    const sendFn = vi.fn().mockResolvedValue(undefined);

    let signalSeen: AbortSignal | undefined;
    const hook = {
      recordAgentResponse: vi.fn(),
      evaluateIntervention: vi.fn(async (_threadId: number, signal?: AbortSignal) => {
        signalSeen = signal;
        await new Promise<never>((_, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted by signal')));
        });
        return null;
      }),
    };

    const localBus = new EventBus();
    new DeliberationHandler(localBus, workers, minConfig, sendFn, {
      facilitatorIntervention: hook,
    });

    const ended = new Promise<void>((resolve) => {
      localBus.on('deliberation.ended', () => resolve());
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      localBus.emit('intent.classified', {
        intent: 'deliberation', complexity: 'medium', threadId: 50,
        message: makeMessage('test', 50),
      });
      await vi.advanceTimersByTimeAsync(60_001);
      await ended;
    } finally {
      vi.useRealTimers();
      errSpy.mockRestore();
    }

    expect(signalSeen).toBeDefined();
    expect(signalSeen?.aborted).toBe(true);
  });

  it('Test J: facilitator intervention completes normally — no abort fires', async () => {
    const workers = [makeWorker('agent-a', 'A'), makeWorker('agent-b', 'B')];
    const sendFn = vi.fn().mockResolvedValue(undefined);

    let signalSeen: AbortSignal | undefined;
    const hook = {
      recordAgentResponse: vi.fn(),
      evaluateIntervention: vi.fn(async (_threadId: number, signal?: AbortSignal) => {
        signalSeen = signal;
        return null;
      }),
    };

    const localBus = new EventBus();
    new DeliberationHandler(localBus, workers, minConfig, sendFn, {
      facilitatorIntervention: hook,
    });

    const ended = new Promise<void>((resolve) => {
      localBus.on('deliberation.ended', () => resolve());
    });

    localBus.emit('intent.classified', {
      intent: 'deliberation', complexity: 'medium', threadId: 51,
      message: makeMessage('test', 51),
    });
    await ended;

    expect(signalSeen).toBeDefined();
    expect(signalSeen?.aborted).toBe(false);
  });
});
