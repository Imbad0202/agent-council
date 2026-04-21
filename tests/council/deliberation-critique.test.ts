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

  it('when convergence is already detected, invited fires BEFORE requested on the SAME agent turn', async () => {
    // Wiring an adapter to convergence needs the invite to precede the
    // critique window for that turn. Otherwise the invite arrives after
    // the window has already closed and is useless.
    //
    // We pre-seed the AntiSycophancyEngine by running one deliberation's
    // worth of agreement classifications, THEN in the next round watch
    // the event order for the FIRST agent turn: invited must arrive
    // before that turn's requested.
    workers[0].respond = vi.fn().mockResolvedValue({
      content: '完全同意上一位 no disagreement',
      confidence: 0.8, references: [], tokensUsed: { input: 0, output: 0 },
    });
    workers[1].respond = vi.fn().mockResolvedValue({
      content: '我也同意，exactly 說得對',
      confidence: 0.8, references: [], tokensUsed: { input: 0, output: 0 },
    });

    const tightConfig = {
      ...minConfig,
      antiSycophancy: { disagreementThreshold: 0.5, consecutiveLowRounds: 2, challengeAngles: ['x'] },
    };

    const eventsByRound: Array<Array<{ type: string }>> = [];
    let currentRound: Array<{ type: string }> = [];
    bus.on('human-critique.invited', () => currentRound.push({ type: 'invited' }));
    bus.on('human-critique.requested', (p) => {
      currentRound.push({ type: 'requested' });
      critiqueStore.skip(p.threadId, 'user-skip');
    });
    bus.on('deliberation.ended', () => {
      eventsByRound.push(currentRound);
      currentRound = [];
    });

    new DeliberationHandler(bus, workers, tightConfig, sendFn, {
      critiqueStore,
      critiqueTimeoutMs: 500,
    });

    // Round 1: accumulate classifications (convergence not yet flagged)
    const r1 = new Promise<void>((resolve) => bus.once('deliberation.ended', () => resolve()));
    bus.emit('intent.classified', {
      intent: 'deliberation', complexity: 'medium', threadId: 33,
      message: makeMessage('q0', 33),
    });
    await r1;

    // Round 2: convergence is already detected from round 1. The FIRST
    // event of round 2 must be invited, before any requested.
    const r2 = new Promise<void>((resolve) => bus.once('deliberation.ended', () => resolve()));
    bus.emit('intent.classified', {
      intent: 'deliberation', complexity: 'medium', threadId: 33,
      message: makeMessage('q1', 33),
    });
    await r2;

    const r2Events = eventsByRound[1];
    expect(r2Events[0]).toEqual({ type: 'invited' });
    expect(r2Events.findIndex((e) => e.type === 'requested')).toBeGreaterThan(0);
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

  it('a single challenge does NOT auto-inflate score to deep/transformative', async () => {
    // Pessimistic-until-proven scoring: submitted critiques start with
    // acknowledgedByNextAgent=false and introducedNovelAngle=false.
    // Without real acknowledgment detection, a single challenge should not
    // be enough to claim "transformative" collaboration depth.
    const payloads: EventMap['deliberation.ended'][] = [];
    bus.on('deliberation.ended', (p) => payloads.push(p));

    bus.on('human-critique.requested', (p) => {
      critiqueStore.submit(p.threadId, {
        stance: 'challenge',
        content: 'one sharp push-back',
      });
    });

    new DeliberationHandler(bus, workers, minConfig, sendFn, {
      critiqueStore,
      critiqueTimeoutMs: 500,
    });

    const done = new Promise<void>((resolve) => {
      bus.on('deliberation.ended', () => resolve());
    });
    bus.emit('intent.classified', {
      intent: 'deliberation',
      complexity: 'medium',
      threadId: 21,
      message: makeMessage('topic', 21),
    });
    await done;

    expect(payloads).toHaveLength(1);
    const score = payloads[0].collaborationScore!;
    expect(score.axisBreakdown.acceptanceRatio).toBe(0);
    expect(score.axisBreakdown.divergenceIntroduced).toBe(0);
    expect(['surface', 'moderate']).toContain(score.level);
  });

  it('critique targeted at agent-b does NOT appear in agent-a history in a later round', async () => {
    // The critique is scoped to the turn of the targeted agent (one-shot
    // injection). It must not leak into subsequent rounds' conversation
    // history where the same agent-a would see it.
    bus.on('human-critique.requested', (p) => {
      if (p.nextAgent === 'agent-b') {
        critiqueStore.submit(p.threadId, { stance: 'challenge', content: 'r1 critique' });
      } else {
        critiqueStore.skip(p.threadId, 'user-skip');
      }
    });

    new DeliberationHandler(bus, workers, minConfig, sendFn, {
      critiqueStore,
      critiqueTimeoutMs: 500,
    });

    // Round 1: critique goes to agent-b
    const r1 = new Promise<void>((resolve) => bus.once('deliberation.ended', () => resolve()));
    bus.emit('intent.classified', {
      intent: 'deliberation', complexity: 'medium', threadId: 50,
      message: makeMessage('r1', 50),
    });
    await r1;

    // Round 2: skip everything. agent-a goes first again.
    const r2 = new Promise<void>((resolve) => bus.once('deliberation.ended', () => resolve()));
    bus.emit('intent.classified', {
      intent: 'deliberation', complexity: 'medium', threadId: 50,
      message: makeMessage('r2', 50),
    });
    await r2;

    // agent-a in round 2 must NOT see the r1 critique (it was targeted at agent-b)
    const agentAMock = workers[0].respond as ReturnType<typeof vi.fn>;
    const r2History = agentAMock.mock.calls[1][0] as CouncilMessage[];
    const stale = r2History.find((m) => m.role === 'human-critique');
    expect(stale).toBeUndefined();
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
