import { describe, it, expect, vi } from 'vitest';
import { DeliberationHandler } from '../../src/council/deliberation.js';
import { EventBus } from '../../src/events/bus.js';
import { makeWorker, minConfig } from './helpers.js';

function makeDeliberationHandler(): DeliberationHandler {
  const bus = new EventBus();
  const workers = [makeWorker('agent-a', 'Agent A'), makeWorker('agent-b', 'Agent B')];
  const sendFn = vi.fn().mockResolvedValue(undefined);
  return new DeliberationHandler(bus, workers, minConfig, sendFn);
}

describe('DeliberationHandler currentResetController per-thread storage (v0.5.4 §3.3)', () => {
  it('getCurrentResetController returns null for thread with no controller set', () => {
    const handler = makeDeliberationHandler();
    expect(handler.getCurrentResetController(1)).toBeNull();
  });

  it('setCurrentResetController stores a controller; getCurrentResetController retrieves it', () => {
    const handler = makeDeliberationHandler();
    const ctrl = new AbortController();
    handler.setCurrentResetController(1, ctrl);
    expect(handler.getCurrentResetController(1)).toBe(ctrl);
  });

  it('thread isolation: setting controller on thread 1 does not affect thread 2', () => {
    const handler = makeDeliberationHandler();
    const ctrlA = new AbortController();
    handler.setCurrentResetController(1, ctrlA);
    expect(handler.getCurrentResetController(2)).toBeNull();
  });

  it('setCurrentResetController with null clears the slot', () => {
    const handler = makeDeliberationHandler();
    const ctrl = new AbortController();
    handler.setCurrentResetController(1, ctrl);
    handler.setCurrentResetController(1, null);
    expect(handler.getCurrentResetController(1)).toBeNull();
  });
});
