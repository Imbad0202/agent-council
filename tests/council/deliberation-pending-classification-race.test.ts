import { describe, it, expect, vi } from 'vitest';
import { DeliberationHandler } from '../../src/council/deliberation.js';
import { EventBus } from '../../src/events/bus.js';
import { makeWorker, minConfig, makeMessage } from './helpers.js';

/**
 * Codex round-3 P1 (v0.5.2.a final review): pendingClassifications race.
 *
 * Production startup registers IntentGate's 'message.received' listener at
 * src/index.ts:182, BEFORE DeliberationHandler at :217. When IntentGate's
 * keyword path classifies synchronously, the listener-firing order is:
 *
 *   1. router emits 'message.received'
 *   2. IntentGate listener fires → keyword match → emits 'intent.classified'
 *      synchronously (still inside step-1 callback chain, before step-1 returns)
 *   3. DeliberationHandler 'intent.classified' listener fires → tries
 *      pendingClassifications.delete(msg.id) → set is empty (DH's add hasn't
 *      run yet) → noop
 *   4. DeliberationHandler 'message.received' listener fires → adds msg.id
 *      to pendingClassifications
 *   5. msg.id stuck in pending forever → /councildone PendingClassificationError
 *
 * The fix in deliberation.ts uses a recentlyClassified Set to detect this
 * ordering and skip the stale add.
 */

describe('DeliberationHandler — pending classification race (codex round-3 P1)', () => {
  it('does NOT leave message.id stuck in pendingClassifications when intent.classified fires before message.received add', () => {
    const bus = new EventBus();
    const workers = [makeWorker('agent-a', 'Agent A')];
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const handler = new DeliberationHandler(bus, workers, minConfig, sendFn);

    const threadId = 42;
    const message = makeMessage('keyword classified path', threadId);

    // Simulate the production race directly: in production, IntentGate's
    // listener (registered earlier, src/index.ts:182 vs :217) fires BEFORE
    // DeliberationHandler's 'message.received' listener and synchronously
    // emits 'intent.classified'. The test fires 'intent.classified' BEFORE
    // 'message.received' to reproduce that exact ordering at the level
    // DeliberationHandler observes (its delete listener fires first, then
    // its add listener fires). The fix's recentlyClassified marker MUST
    // catch this ordering.
    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'medium',
      threadId,
      message,
    });
    bus.emit('message.received', { message, threadId });

    // The message.id MUST NOT linger in pendingClassifications, otherwise
    // ArtifactService PendingClassificationError fires forever for this thread.
    expect(handler.hasPendingClassifications(threadId)).toBe(false);
  });

  it('preserves the normal ordering: add → delete leaves pending empty', () => {
    const bus = new EventBus();
    const workers = [makeWorker('agent-a', 'Agent A')];
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const handler = new DeliberationHandler(bus, workers, minConfig, sendFn);

    const threadId = 50;
    const message = makeMessage('async classify path', threadId);

    // Normal order: message.received fires, DH adds pending, classification
    // fires later (asynchronously in production).
    bus.emit('message.received', { message, threadId });
    expect(handler.hasPendingClassifications(threadId)).toBe(true);

    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'medium',
      threadId,
      message,
    });
    expect(handler.hasPendingClassifications(threadId)).toBe(false);
  });

  it('handles multiple concurrent messages with mixed ordering', () => {
    const bus = new EventBus();
    const workers = [makeWorker('agent-a', 'Agent A')];
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const handler = new DeliberationHandler(bus, workers, minConfig, sendFn);

    const threadId = 99;
    const msgRace = makeMessage('race-path message', threadId);
    const msgNormal = makeMessage('normal-path message', threadId);

    // First: race-path message — intent.classified fires before message.received
    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'medium',
      threadId,
      message: msgRace,
    });
    bus.emit('message.received', { message: msgRace, threadId });
    expect(handler.hasPendingClassifications(threadId)).toBe(false);

    // Second: normal-path message — message.received first, classification later
    bus.emit('message.received', { message: msgNormal, threadId });
    expect(handler.hasPendingClassifications(threadId)).toBe(true);

    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'medium',
      threadId,
      message: msgNormal,
    });
    expect(handler.hasPendingClassifications(threadId)).toBe(false);
  });
});
