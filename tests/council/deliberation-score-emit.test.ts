import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DeliberationHandler } from '../../src/council/deliberation.js';
import { HumanCritiqueStore } from '../../src/council/human-critique-store.js';
import { EventBus } from '../../src/events/bus.js';
import type { EventMap } from '../../src/events/bus.js';
import type { AgentWorker } from '../../src/worker/agent-worker.js';
import type { ProviderResponse } from '../../src/types.js';
import { makeWorker, minConfig, makeMessage } from './helpers.js';

describe('DeliberationHandler — facilitator summary + collaboration score', () => {
  let bus: EventBus;
  let workers: AgentWorker[];
  let sendFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    bus = new EventBus();
    workers = [makeWorker('agent-a', 'Agent A'), makeWorker('agent-b', 'Agent B')];
    sendFn = vi.fn().mockResolvedValue(undefined);
  });

  it('deliberation.ended payload includes collaborationScore', async () => {
    let endedPayload: EventMap['deliberation.ended'] | null = null;
    const done = new Promise<void>((resolve) => {
      bus.on('deliberation.ended', (p) => { endedPayload = p; resolve(); });
    });

    new DeliberationHandler(bus, workers, minConfig, sendFn);
    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'medium',
      threadId: 1,
      message: makeMessage('hi', 1),
    });
    await done;

    expect(endedPayload).not.toBeNull();
    // Cast locally because Vitest's inferred type narrowing loses the assignment
    const payload = endedPayload as unknown as EventMap['deliberation.ended'];
    expect(payload.collaborationScore).toBeDefined();
    expect(payload.collaborationScore!.level).toBe('surface');
    expect(payload.collaborationScore!.axisBreakdown.interruptionRate).toBe(0);
  });

  it('collaborationScore reflects submitted critiques at end', async () => {
    const critiqueStore = new HumanCritiqueStore();
    bus.on('human-critique.requested', (p) => {
      critiqueStore.submit(p.threadId, { stance: 'challenge', content: 'cost?' });
    });

    let endedPayload: EventMap['deliberation.ended'] | null = null;
    const done = new Promise<void>((resolve) => {
      bus.on('deliberation.ended', (p) => { endedPayload = p; resolve(); });
    });

    new DeliberationHandler(bus, workers, minConfig, sendFn, {
      critiqueStore,
      critiqueTimeoutMs: 1_000,
    });
    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'medium',
      threadId: 2,
      message: makeMessage('topic', 2),
    });
    await done;

    const payload = endedPayload as unknown as EventMap['deliberation.ended'];
    expect(payload.collaborationScore!.axisBreakdown.interruptionRate).toBeGreaterThan(0);
    // Pessimistic scoring: acceptance/novel default to 0 without
    // agent-side acknowledgment detection.
    expect(payload.collaborationScore!.axisBreakdown.acceptanceRatio).toBe(0);
  });

  it('collaborationScore resets between rounds on the same thread', async () => {
    const critiqueStore = new HumanCritiqueStore();
    let critiqueRound1Done = false;
    bus.on('human-critique.requested', (p) => {
      if (!critiqueRound1Done) {
        critiqueStore.submit(p.threadId, { stance: 'challenge', content: 'R1 cost' });
      } else {
        critiqueStore.skip(p.threadId, 'user-skip');
      }
    });

    const payloads: EventMap['deliberation.ended'][] = [];
    bus.on('deliberation.ended', (p) => payloads.push(p));

    new DeliberationHandler(bus, workers, minConfig, sendFn, {
      critiqueStore,
      critiqueTimeoutMs: 500,
    });

    // Round 1 — user submits a critique
    const r1 = new Promise<void>((resolve) => bus.once('deliberation.ended', () => resolve()));
    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'medium',
      threadId: 42,
      message: makeMessage('q1', 42),
    });
    await r1;
    critiqueRound1Done = true;

    // Round 2 — user skips everything
    const r2 = new Promise<void>((resolve) => bus.once('deliberation.ended', () => resolve()));
    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'medium',
      threadId: 42,
      message: makeMessage('q2', 42),
    });
    await r2;

    expect(payloads).toHaveLength(2);
    // Round 1 should show critique activity
    expect(payloads[0].collaborationScore!.axisBreakdown.interruptionRate).toBeGreaterThan(0);
    // Round 2 should be clean — no critiques, rate back to 0 (stats reset)
    expect(payloads[1].collaborationScore!.axisBreakdown.interruptionRate).toBe(0);
    expect(payloads[1].collaborationScore!.level).toBe('surface');
  });

  it('facilitator summary prompt contains the score level', async () => {
    const facilitatorRespond = vi.fn<[], Promise<ProviderResponse>>().mockResolvedValue({
      content: 'summary body',
      confidence: 0.5,
      references: [],
      tokensUsed: { input: 0, output: 0 },
    });
    const facilitatorWorker = {
      id: 'facilitator',
      name: 'Facilitator',
      respond: facilitatorRespond,
    } as unknown as AgentWorker;

    new DeliberationHandler(bus, workers, minConfig, sendFn, { facilitatorWorker });

    const done = new Promise<void>((resolve) => {
      bus.on('deliberation.ended', () => resolve());
    });
    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'medium',
      threadId: 3,
      message: makeMessage('q', 3),
    });
    await done;

    expect(facilitatorRespond).toHaveBeenCalled();
    const summaryHistory = facilitatorRespond.mock.calls[0][0];
    const summaryContent = summaryHistory[0].content;
    // The summary prompt should reference either the level name or the phrase "協作深度"
    expect(summaryContent).toMatch(/協作深度|surface|moderate|deep|transformative/);
  });
});
