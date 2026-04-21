import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../src/events/bus.js';
import type { EventMap } from '../../src/events/bus.js';

describe('EventBus human-critique events', () => {
  it('human-critique.requested carries prev/next agent context', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const payload: EventMap['human-critique.requested'] = {
      threadId: 1,
      prevAgent: 'huahua',
      nextAgent: 'binbin',
    };
    bus.on('human-critique.requested', handler);
    bus.emit('human-critique.requested', payload);
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('human-critique.submitted carries stance, content, targetAgent', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const payload: EventMap['human-critique.submitted'] = {
      threadId: 1,
      stance: 'challenge',
      content: 'You ignored scale',
      targetAgent: 'binbin',
    };
    bus.on('human-critique.submitted', handler);
    bus.emit('human-critique.submitted', payload);
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('human-critique.skipped has reason union', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const reasons: Array<EventMap['human-critique.skipped']['reason']> = [
      'timeout',
      'user-skip',
      'disabled',
    ];
    bus.on('human-critique.skipped', handler);
    for (const reason of reasons) {
      bus.emit('human-critique.skipped', { threadId: 1, reason });
    }
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('human-critique.invited fires with convergence trigger', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const payload: EventMap['human-critique.invited'] = {
      threadId: 2,
      trigger: 'convergence',
    };
    bus.on('human-critique.invited', handler);
    bus.emit('human-critique.invited', payload);
    expect(handler).toHaveBeenCalledWith(payload);
  });
});
