import { describe, it, expect, vi } from 'vitest';
import { DeliberationHandler } from '../../src/council/deliberation.js';
import { EventBus } from '../../src/events/bus.js';
import type { EventMap } from '../../src/events/bus.js';
import { makeWorker, minConfig, makeMessage } from './helpers.js';

describe('DeliberationHandler synthesisInFlight flag', () => {
  it('isSynthesisInFlight defaults to false for a new thread', () => {
    const bus = new EventBus();
    const workers = [makeWorker('agent-a', 'Agent A'), makeWorker('agent-b', 'Agent B')];
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const handler = new DeliberationHandler(bus, workers, minConfig, sendFn);

    // Materialize the session (session init via isResetInFlight as a side-effect free getter)
    expect(handler.isSynthesisInFlight(1)).toBe(false);
  });

  it('setSynthesisInFlight(t, true) is observable via isSynthesisInFlight(t)', () => {
    const bus = new EventBus();
    const workers = [makeWorker('agent-a', 'Agent A'), makeWorker('agent-b', 'Agent B')];
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const handler = new DeliberationHandler(bus, workers, minConfig, sendFn);

    const threadId = 10;
    handler.isSynthesisInFlight(threadId); // materialize session
    handler.setSynthesisInFlight(threadId, true);
    expect(handler.isSynthesisInFlight(threadId)).toBe(true);
  });

  it('setSynthesisInFlight is per-thread scoped (thread 1 does not affect thread 2)', () => {
    const bus = new EventBus();
    const workers = [makeWorker('agent-a', 'Agent A'), makeWorker('agent-b', 'Agent B')];
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const handler = new DeliberationHandler(bus, workers, minConfig, sendFn);

    // Materialize both sessions
    handler.isSynthesisInFlight(1);
    handler.isSynthesisInFlight(2);

    handler.setSynthesisInFlight(1, true);
    expect(handler.isSynthesisInFlight(1)).toBe(true);
    expect(handler.isSynthesisInFlight(2)).toBe(false);
  });

  it('setSynthesisInFlight(t, false) clears the flag', () => {
    const bus = new EventBus();
    const workers = [makeWorker('agent-a', 'Agent A'), makeWorker('agent-b', 'Agent B')];
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const handler = new DeliberationHandler(bus, workers, minConfig, sendFn);

    const threadId = 20;
    handler.isSynthesisInFlight(threadId); // materialize session
    handler.setSynthesisInFlight(threadId, true);
    expect(handler.isSynthesisInFlight(threadId)).toBe(true);
    handler.setSynthesisInFlight(threadId, false);
    expect(handler.isSynthesisInFlight(threadId)).toBe(false);
  });

  it('runDeliberation skips and notifies user when synthesisInFlight is true', async () => {
    const bus = new EventBus();
    const workers = [makeWorker('agent-a', 'Agent A'), makeWorker('agent-b', 'Agent B')];
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const handler = new DeliberationHandler(bus, workers, minConfig, sendFn);

    const threadId = 30;
    // Materialize the session, then flag synthesis-in-flight.
    handler.isSynthesisInFlight(threadId);
    handler.setSynthesisInFlight(threadId, true);

    const agentResponded: EventMap['agent.responded'][] = [];
    bus.on('agent.responded', (payload) => agentResponded.push(payload));

    const message = makeMessage('user message during synthesis', threadId);

    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'medium',
      threadId,
      message,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Agents should not have been called
    expect(agentResponded).toHaveLength(0);
    for (const w of workers) {
      expect(w.respond).not.toHaveBeenCalled();
    }
    // User gets a notice about synthesis in progress
    const replies = sendFn.mock.calls.map((call) => String(call[1] ?? ''));
    expect(replies.some((r) => /synthesis/i.test(r))).toBe(true);
    // The dropped message must NOT have been pushed into the current segment
    expect(handler.getCurrentSegmentMessages(threadId)).toHaveLength(0);
  });
});
