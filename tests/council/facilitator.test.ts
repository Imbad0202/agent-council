import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FacilitatorAgent } from '../../src/council/facilitator.js';
import { EventBus } from '../../src/events/bus.js';
import type { EventMap } from '../../src/events/bus.js';
import type { AgentWorker } from '../../src/worker/agent-worker.js';
import type { ProviderResponse } from '../../src/types.js';

function makeWorker(respondResult: string): AgentWorker {
  return {
    id: 'facilitator',
    name: '主持人',
    respond: vi.fn<[], Promise<ProviderResponse>>().mockResolvedValue({
      content: respondResult,
      tokensUsed: { input: 50, output: 30 },
    }),
  } as unknown as AgentWorker;
}

describe('FacilitatorAgent', () => {
  let bus: EventBus;
  let worker: AgentWorker;
  let _facilitator: FacilitatorAgent;

  beforeEach(() => {
    bus = new EventBus();
  });

  describe('deliberation.started → announceStructure', () => {
    it('emits facilitator.intervened with action=structure on deliberation.started', async () => {
      worker = makeWorker('{"action": "none", "content": "", "target_agent": null}');
      _facilitator = new FacilitatorAgent(bus, worker);

      const events: EventMap['facilitator.intervened'][] = [];
      bus.on('facilitator.intervened', (p) => events.push(p));

      bus.emit('deliberation.started', {
        threadId: 1,
        participants: ['huahua', 'binbin'],
        roles: { huahua: 'advocate', binbin: 'critic' },
        structure: 'free',
      });

      // Give a tick for async operations
      await new Promise((r) => setTimeout(r, 10));

      expect(events).toHaveLength(1);
      expect(events[0].threadId).toBe(1);
      expect(events[0].action).toBe('structure');
      expect(events[0].content).toBeTruthy();
    });

    it('initializes history for the thread on deliberation.started; <2 messages → no worker call', async () => {
      worker = makeWorker('{"action": "none", "content": "", "target_agent": null}');
      _facilitator = new FacilitatorAgent(bus, worker);

      bus.emit('deliberation.started', {
        threadId: 42,
        participants: ['huahua', 'binbin'],
        roles: { huahua: 'advocate', binbin: 'critic' },
        structure: 'structured',
      });

      await new Promise((r) => setTimeout(r, 10));

      // Caller records first agent response then evaluates — only 1 message
      // in history, so the < 2 guard inside evaluateIntervention skips the
      // worker call.
      _facilitator.recordAgentResponse(42, 'huahua', 'First response');
      await _facilitator.evaluateIntervention(42);

      expect(worker.respond as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    });
  });

  describe('agent.responded → evaluateIntervention', () => {
    // v0.5.2 P1-B: facilitator no longer subscribes to agent.responded.
    // Caller (DeliberationHandler.runDeliberation) drives recordAgentResponse
    // + evaluateIntervention inline. These tests exercise the public API
    // directly, mirroring what the caller does.
    it('calls worker.respond after 2+ messages in history', async () => {
      worker = makeWorker('{"action": "none", "content": "", "target_agent": null}');
      _facilitator = new FacilitatorAgent(bus, worker);

      bus.emit('deliberation.started', {
        threadId: 5,
        participants: ['huahua', 'binbin'],
        roles: { huahua: 'advocate', binbin: 'critic' },
        structure: 'free',
      });
      await new Promise((r) => setTimeout(r, 10));

      // First agent response — history becomes 1
      _facilitator.recordAgentResponse(5, 'huahua', 'Response A');
      await _facilitator.evaluateIntervention(5);

      // Should not have called worker.respond yet (only 1 message)
      expect(worker.respond as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();

      // Second agent response — history becomes 2
      _facilitator.recordAgentResponse(5, 'binbin', 'Response B');
      await _facilitator.evaluateIntervention(5);

      // Now worker.respond SHOULD have been called
      expect(worker.respond as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    });

    it('returns intervention decision when worker returns non-none action', async () => {
      // v0.5.2 P1-B option C: evaluateIntervention now RETURNS the decision
      // instead of emitting facilitator.intervened. Caller decides whether
      // to push + emit. announceStructure still emits directly (display-only).
      worker = makeWorker('{"action": "steer", "content": "請聚焦在可行性上。", "target_agent": null}');
      _facilitator = new FacilitatorAgent(bus, worker);

      _facilitator.recordAgentResponse(7, 'huahua', 'I think we should go with microservices.');
      _facilitator.recordAgentResponse(7, 'binbin', 'I agree, microservices are great!');
      const result = await _facilitator.evaluateIntervention(7);

      expect(result).toEqual({
        action: 'steer',
        content: '請聚焦在可行性上。',
      });
    });

    it('returns null when worker returns action=none', async () => {
      worker = makeWorker('{"action": "none", "content": "", "target_agent": null}');
      _facilitator = new FacilitatorAgent(bus, worker);

      _facilitator.recordAgentResponse(8, 'huahua', 'Response 1');
      _facilitator.recordAgentResponse(8, 'binbin', 'Response 2');
      const result = await _facilitator.evaluateIntervention(8);

      expect(result).toBeNull();
    });

    it('returns targetAgent in decision when worker returns non-null target_agent', async () => {
      worker = makeWorker('{"action": "challenge", "content": "你的論點有漏洞。", "target_agent": "binbin"}');
      _facilitator = new FacilitatorAgent(bus, worker);

      _facilitator.recordAgentResponse(9, 'huahua', 'A response');
      _facilitator.recordAgentResponse(9, 'binbin', 'Another response');
      const result = await _facilitator.evaluateIntervention(9);

      expect(result).toEqual({
        action: 'challenge',
        content: '你的論點有漏洞。',
        targetAgent: 'binbin',
      });
    });
  });

  // v0.5.2 P1-B option C (codex round-4 [P2]): convergence.detected and
  // pattern.detected listeners removed. Methods are now public so the
  // future trigger site can call them directly and route the returned
  // decision through DeliberationHandler's inline path. Tests exercise
  // the public API instead of the dropped listener flow.
  describe('handleConvergence (public method)', () => {
    it('calls worker.respond when invoked', async () => {
      worker = makeWorker('{"action": "challenge", "content": "你們達成了共識，但有沒有考慮成本？", "target_agent": null}');
      _facilitator = new FacilitatorAgent(bus, worker);
      await _facilitator.handleConvergence(11, 'cost');
      expect(worker.respond as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    });

    it('returns challenge decision when worker returns non-none action', async () => {
      worker = makeWorker('{"action": "challenge", "content": "請挑戰這個共識。", "target_agent": null}');
      _facilitator = new FacilitatorAgent(bus, worker);
      const result = await _facilitator.handleConvergence(12, 'risk');
      expect(result).toEqual({ action: 'challenge', content: '請挑戰這個共識。' });
    });

    it('returns null when worker returns none', async () => {
      worker = makeWorker('{"action": "none", "content": "", "target_agent": null}');
      _facilitator = new FacilitatorAgent(bus, worker);
      const result = await _facilitator.handleConvergence(13, 'alternatives');
      expect(result).toBeNull();
    });
  });

  describe('handlePattern (public method)', () => {
    it('returns challenge decision with target agent and pattern content (no worker call)', () => {
      worker = makeWorker('{"action": "none", "content": "", "target_agent": null}');
      _facilitator = new FacilitatorAgent(bus, worker);
      const result = _facilitator.handlePattern(15, 'binbin', 'mirror');
      expect(result.action).toBe('challenge');
      expect(result.targetAgent).toBe('binbin');
      expect(result.content).toBeTruthy();
      expect(worker.respond as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    });

    it('routes pattern-specific content for fake_dissent', () => {
      worker = makeWorker('{"action": "none", "content": "", "target_agent": null}');
      _facilitator = new FacilitatorAgent(bus, worker);
      const result = _facilitator.handlePattern(16, 'huahua', 'fake_dissent');
      expect(result.targetAgent).toBe('huahua');
    });
  });

  describe('evaluateIntervention signal (v0.5.3 §5.1 site 2)', () => {
    it('forwards signal to worker.respond as 7th positional arg', async () => {
      const capturedArgs: unknown[][] = [];
      const mockWorker = {
        id: 'facilitator-w',
        respond: vi.fn(async (...args: unknown[]) => {
          capturedArgs.push(args);
          return { content: '{}', model: 'm', tokensUsed: { input: 1, output: 1 } };
        }),
      } as unknown as AgentWorker;

      const localBus = new EventBus();
      const fac = new FacilitatorAgent(localBus, mockWorker);

      localBus.emit('deliberation.started', {
        threadId: 100,
        participants: ['a', 'b'],
        roles: {},
        structure: 'free',
      });

      fac.recordAgentResponse(100, 'a', 'first turn');
      fac.recordAgentResponse(100, 'b', 'second turn');

      const ctrl = new AbortController();
      await fac.evaluateIntervention(100, ctrl.signal);

      expect(capturedArgs).toHaveLength(1);
      expect(capturedArgs[0][6]).toBe(ctrl.signal); // 7th positional (index 6)
    });

    it('back-compat: evaluateIntervention(threadId) without signal still works', async () => {
      const mockWorker = {
        id: 'facilitator-w',
        respond: vi.fn(async () => ({
          content: '{}',
          model: 'm',
          tokensUsed: { input: 1, output: 1 },
        })),
      } as unknown as AgentWorker;

      const localBus = new EventBus();
      const fac = new FacilitatorAgent(localBus, mockWorker);

      localBus.emit('deliberation.started', {
        threadId: 101,
        participants: ['a', 'b'],
        roles: {},
        structure: 'free',
      });

      fac.recordAgentResponse(101, 'a', 'first turn');
      fac.recordAgentResponse(101, 'b', 'second turn');

      await fac.evaluateIntervention(101);
      expect(mockWorker.respond as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    });
  });

  describe('deliberation.ended → cleanup', () => {
    it('cleans up history on deliberation.ended', async () => {
      worker = makeWorker('{"action": "none", "content": "", "target_agent": null}');
      _facilitator = new FacilitatorAgent(bus, worker);

      bus.emit('deliberation.started', {
        threadId: 20,
        participants: ['huahua', 'binbin'],
        roles: {},
        structure: 'free',
      });
      await new Promise((r) => setTimeout(r, 10));

      // Add some history
      bus.emit('agent.responded', {
        threadId: 20,
        agentId: 'huahua',
        response: { content: 'Response', tokensUsed: { input: 10, output: 10 } },
        role: 'advocate',
        classification: 'opposition',
      });
      await new Promise((r) => setTimeout(r, 10));

      // End deliberation
      bus.emit('deliberation.ended', {
        threadId: 20,
        conclusion: 'Done',
        intent: 'deliberation',
      });
      await new Promise((r) => setTimeout(r, 10));

      // After cleanup, a new deliberation.started should re-initialize history
      const interventions: EventMap['facilitator.intervened'][] = [];
      bus.on('facilitator.intervened', (p) => interventions.push(p));

      bus.emit('deliberation.started', {
        threadId: 20,
        participants: ['huahua', 'binbin'],
        roles: {},
        structure: 'free',
      });
      await new Promise((r) => setTimeout(r, 10));

      // structure announce should fire again
      const structureInterventions = interventions.filter((i) => i.action === 'structure');
      expect(structureInterventions).toHaveLength(1);
    });
  });
});
