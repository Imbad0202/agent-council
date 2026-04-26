import { describe, it, expect } from 'vitest';
import { EventBus } from '../../src/events/bus.js';

describe('artifact.created event', () => {
  it('emits and receives a typed artifact.created payload', () => {
    const bus = new EventBus();
    let received: { threadId: number; segmentIndex: number; threadLocalSeq: number; preset: 'universal' | 'decision' } | null = null;
    bus.on('artifact.created', (e) => { received = e; });

    bus.emit('artifact.created', {
      threadId: 42, segmentIndex: 3, threadLocalSeq: 1, preset: 'universal',
    });

    expect(received).toEqual({ threadId: 42, segmentIndex: 3, threadLocalSeq: 1, preset: 'universal' });
  });
});
