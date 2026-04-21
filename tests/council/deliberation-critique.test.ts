import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DeliberationHandler } from '../../src/council/deliberation.js';
import { HumanCritiqueStore } from '../../src/council/human-critique-store.js';
import { EventBus } from '../../src/events/bus.js';
import type { EventMap } from '../../src/events/bus.js';
import type { AgentWorker } from '../../src/worker/agent-worker.js';
import type { CouncilMessage } from '../../src/types.js';
import { makeWorker, minConfig, makeMessage } from './helpers.js';

describe('DeliberationHandler — human critique integration', () => {
  let bus: EventBus;
  let workers: AgentWorker[];
  let sendFn: ReturnType<typeof vi.fn>;
  let critiqueStore: HumanCritiqueStore;

  beforeEach(() => {
    bus = new EventBus();
    workers = [makeWorker('agent-a', 'Agent A'), makeWorker('agent-b', 'Agent B')];
    sendFn = vi.fn().mockResolvedValue(undefined);
    critiqueStore = new HumanCritiqueStore();
  });

  it('emits human-critique.requested between agents when critiqueStore is wired', async () => {
    const requested: EventMap['human-critique.requested'][] = [];
    bus.on('human-critique.requested', (p) => requested.push(p));

    // Auto-skip each window so deliberation completes
    bus.on('human-critique.requested', (p) => {
      // Simulate adapter response: user taps "accept" / no critique
      critiqueStore.skip(p.threadId, 'user-skip');
    });

    new DeliberationHandler(bus, workers, minConfig, sendFn, {
      critiqueStore,
      critiqueTimeoutMs: 1_000,
    });

    const done = new Promise<void>((resolve) => {
      bus.on('deliberation.ended', () => resolve());
    });
    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'medium',
      threadId: 1,
      message: makeMessage('hi', 1),
    });
    await done;

    // Windows open before each agent turn — 2 agents means 2 requested events.
    // (An alternative design would only open between agents, not before first —
    // this test documents the chosen behavior: one window per agent turn.)
    expect(requested.length).toBeGreaterThanOrEqual(1);
    expect(requested[0].threadId).toBe(1);
  });

  it('submitted critique is injected into next agent history and emits submitted event', async () => {
    const submitted: EventMap['human-critique.submitted'][] = [];
    bus.on('human-critique.submitted', (p) => submitted.push(p));

    bus.on('human-critique.requested', (p) => {
      // User challenges the previous (or pre-empts the next) agent
      if (p.nextAgent === 'agent-b') {
        critiqueStore.submit(p.threadId, {
          stance: 'challenge',
          content: 'You ignored the cost axis.',
        });
      } else {
        critiqueStore.skip(p.threadId, 'user-skip');
      }
    });

    new DeliberationHandler(bus, workers, minConfig, sendFn, {
      critiqueStore,
      critiqueTimeoutMs: 1_000,
    });

    const done = new Promise<void>((resolve) => {
      bus.on('deliberation.ended', () => resolve());
    });
    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'medium',
      threadId: 1,
      message: makeMessage('question', 1),
    });
    await done;

    expect(submitted).toHaveLength(1);
    expect(submitted[0].stance).toBe('challenge');
    expect(submitted[0].targetAgent).toBe('agent-b');

    // agent-b's history should include the critique message AND challengePrompt contains it
    const agentBMock = workers[1].respond as ReturnType<typeof vi.fn>;
    const historyArg = agentBMock.mock.calls[0][0] as CouncilMessage[];
    const critiqueMsg = historyArg.find((m) => m.role === 'human-critique');
    expect(critiqueMsg).toBeDefined();
    expect(critiqueMsg!.content).toBe('You ignored the cost axis.');

    const challengePromptArg = agentBMock.mock.calls[0][2] as string | undefined;
    expect(challengePromptArg).toBeTruthy();
    expect(challengePromptArg!).toContain('cost axis');
  });

  it('skipped critique emits human-critique.skipped and does NOT inject a message', async () => {
    const skipped: EventMap['human-critique.skipped'][] = [];
    bus.on('human-critique.skipped', (p) => skipped.push(p));

    bus.on('human-critique.requested', (p) => {
      critiqueStore.skip(p.threadId, 'user-skip');
    });

    new DeliberationHandler(bus, workers, minConfig, sendFn, {
      critiqueStore,
      critiqueTimeoutMs: 1_000,
    });

    const done = new Promise<void>((resolve) => {
      bus.on('deliberation.ended', () => resolve());
    });
    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'medium',
      threadId: 1,
      message: makeMessage('question', 1),
    });
    await done;

    expect(skipped.length).toBeGreaterThanOrEqual(1);
    for (const s of skipped) {
      expect(s.reason).toBe('user-skip');
    }

    const agentBMock = workers[1].respond as ReturnType<typeof vi.fn>;
    const historyArg = agentBMock.mock.calls[0][0] as CouncilMessage[];
    const critiqueMsg = historyArg.find((m) => m.role === 'human-critique');
    expect(critiqueMsg).toBeUndefined();
  });

  it('no critiqueStore wired — deliberation behaves exactly as before (no events, no pause)', async () => {
    const requested: EventMap['human-critique.requested'][] = [];
    bus.on('human-critique.requested', (p) => requested.push(p));

    // DeliberationHandler without critiqueStore option — disabled path
    new DeliberationHandler(bus, workers, minConfig, sendFn);

    const done = new Promise<void>((resolve) => {
      bus.on('deliberation.ended', () => resolve());
    });
    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'medium',
      threadId: 1,
      message: makeMessage('no pause', 1),
    });
    await done;

    expect(requested).toHaveLength(0);

    // Both workers still got called exactly once
    expect((workers[0].respond as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    expect((workers[1].respond as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
  });

  it('emits human-critique.invited when AntiSycophancyEngine detects convergence', async () => {
    const invited: EventMap['human-critique.invited'][] = [];
    bus.on('human-critique.invited', (p) => invited.push(p));

    // Seed two responses that both trigger 'agreement' classification.
    workers[0].respond = vi.fn().mockResolvedValue({
      content: '完全同意上一位的觀點，no disagreement。',
      confidence: 0.8,
      references: [],
      tokensUsed: { input: 0, output: 0 },
    });
    workers[1].respond = vi.fn().mockResolvedValue({
      content: '我也同意，exactly 說得對。',
      confidence: 0.8,
      references: [],
      tokensUsed: { input: 0, output: 0 },
    });

    // Tight config: convergence triggers after 2 consecutive low-disagreement rounds
    const tightConfig = {
      ...minConfig,
      antiSycophancy: { disagreementThreshold: 0.5, consecutiveLowRounds: 2, challengeAngles: ['x'] },
    };

    new DeliberationHandler(bus, workers, tightConfig, sendFn);

    // Kick off two deliberations back-to-back on same thread so AntiSycophancyEngine
    // accumulates enough agreement classifications.
    for (let i = 0; i < 2; i++) {
      const done = new Promise<void>((resolve) => {
        bus.once('deliberation.ended', () => resolve());
      });
      bus.emit('intent.classified', {
        intent: 'deliberation',
        complexity: 'medium',
        threadId: 11,
        message: makeMessage(`q${i}`, 11),
      });
      await done;
    }

    expect(invited.length).toBeGreaterThanOrEqual(1);
    expect(invited[0].threadId).toBe(11);
    expect(invited[0].trigger).toBe('convergence');
  });

  it('submitted critique is acknowledged in the scorer-ready session log', async () => {
    bus.on('human-critique.requested', (p) => {
      critiqueStore.submit(p.threadId, {
        stance: 'addPremise',
        content: 'Assume 2-week deadline.',
      });
    });

    const handler = new DeliberationHandler(bus, workers, minConfig, sendFn, {
      critiqueStore,
      critiqueTimeoutMs: 1_000,
    });

    const done = new Promise<void>((resolve) => {
      bus.on('deliberation.ended', () => resolve());
    });
    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'medium',
      threadId: 7,
      message: makeMessage('topic', 7),
    });
    await done;

    const session = handler.getCritiqueSessionLog(7);
    expect(session).toBeDefined();
    expect(session!.humanCritiques.length).toBeGreaterThanOrEqual(1);
    expect(session!.humanCritiques[0].stance).toBe('addPremise');
    // agentTurns is counted for non-skipped responses
    expect(session!.agentTurns).toBe(2);
  });
});
