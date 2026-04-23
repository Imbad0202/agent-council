import { vi } from 'vitest';
import { DeliberationHandler } from '../../src/council/deliberation.js';
import { EventBus } from '../../src/events/bus.js';
import type { AgentWorker } from '../../src/worker/agent-worker.js';
import { makeWorker, minConfig } from '../council/helpers.js';

export interface TestHandlerBundle {
  handler: DeliberationHandler;
  bus: EventBus;
  workers: AgentWorker[];
  sendFn: ReturnType<typeof vi.fn>;
}

export function buildTestHandler(): TestHandlerBundle {
  const bus = new EventBus();
  const workers = [
    makeWorker('agent-a', 'Agent A'),
    makeWorker('agent-b', 'Agent B'),
  ];
  const sendFn = vi.fn().mockResolvedValue(undefined);
  const handler = new DeliberationHandler(bus, workers, minConfig, sendFn);
  return { handler, bus, workers, sendFn };
}
