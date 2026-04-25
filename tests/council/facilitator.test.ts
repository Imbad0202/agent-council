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

  describe('convergence.detected → handleConvergence', () => {
    it('calls worker.respond on convergence.detected', async () => {
      worker = makeWorker('{"action": "challenge", "content": "你們達成了共識，但有沒有考慮成本？", "target_agent": null}');
      _facilitator = new FacilitatorAgent(bus, worker);

      bus.emit('deliberation.started', {
        threadId: 11,
        participants: ['huahua', 'binbin'],
        roles: {},
        structure: 'free',
      });
      await new Promise((r) => setTimeout(r, 10));

      bus.emit('convergence.detected', {
        threadId: 11,
        angle: 'cost',
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(worker.respond as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    });

    it('emits facilitator.intervened with challenge action on convergence', async () => {
      worker = makeWorker('{"action": "challenge", "content": "請挑戰這個共識。", "target_agent": null}');
      _facilitator = new FacilitatorAgent(bus, worker);

      const interventions: EventMap['facilitator.intervened'][] = [];
      bus.on('facilitator.intervened', (p) => interventions.push(p));

      bus.emit('deliberation.started', {
        threadId: 12,
        participants: ['huahua', 'binbin'],
        roles: {},
        structure: 'free',
      });
      await new Promise((r) => setTimeout(r, 10));

      const structureCount = interventions.length;

      bus.emit('convergence.detected', {
        threadId: 12,
        angle: 'risk',
      });
      await new Promise((r) => setTimeout(r, 50));

      const newInterventions = interventions.slice(structureCount);
      expect(newInterventions).toHaveLength(1);
      expect(newInterventions[0].action).toBe('challenge');
      expect(newInterventions[0].content).toBe('請挑戰這個共識。');
    });

    it('does not emit when worker returns none on convergence', async () => {
      worker = makeWorker('{"action": "none", "content": "", "target_agent": null}');
      _facilitator = new FacilitatorAgent(bus, worker);

      const interventions: EventMap['facilitator.intervened'][] = [];
      bus.on('facilitator.intervened', (p) => interventions.push(p));

      bus.emit('deliberation.started', {
        threadId: 13,
        participants: ['huahua', 'binbin'],
        roles: {},
        structure: 'free',
      });
      await new Promise((r) => setTimeout(r, 10));

      const structureCount = interventions.length;

      bus.emit('convergence.detected', {
        threadId: 13,
        angle: 'alternatives',
      });
      await new Promise((r) => setTimeout(r, 50));

      const newInterventions = interventions.slice(structureCount);
      expect(newInterventions).toHaveLength(0);
    });
  });

  describe('pattern.detected → handlePattern', () => {
    it('emits facilitator.intervened with challenge directly (no worker call)', async () => {
      worker = makeWorker('{"action": "none", "content": "", "target_agent": null}');
      _facilitator = new FacilitatorAgent(bus, worker);

      const interventions: EventMap['facilitator.intervened'][] = [];
      bus.on('facilitator.intervened', (p) => interventions.push(p));

      bus.emit('deliberation.started', {
        threadId: 15,
        participants: ['huahua', 'binbin'],
        roles: {},
        structure: 'free',
      });
      await new Promise((r) => setTimeout(r, 10));

      const structureCount = interventions.length;

      bus.emit('pattern.detected', {
        threadId: 15,
        pattern: 'mirror',
        targetAgent: 'binbin',
      });
      await new Promise((r) => setTimeout(r, 10));

      const newInterventions = interventions.slice(structureCount);
      expect(newInterventions).toHaveLength(1);
      expect(newInterventions[0].action).toBe('challenge');
      expect(newInterventions[0].targetAgent).toBe('binbin');
      expect(newInterventions[0].content).toBeTruthy();
      // worker.respond should NOT have been called for pattern handling
      expect(worker.respond as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    });

    it('includes pattern-relevant content in challenge for fake_dissent pattern', async () => {
      worker = makeWorker('{"action": "none", "content": "", "target_agent": null}');
      _facilitator = new FacilitatorAgent(bus, worker);

      const interventions: EventMap['facilitator.intervened'][] = [];
      bus.on('facilitator.intervened', (p) => interventions.push(p));

      bus.emit('deliberation.started', {
        threadId: 16,
        participants: ['huahua', 'binbin'],
        roles: {},
        structure: 'free',
      });
      await new Promise((r) => setTimeout(r, 10));

      const structureCount = interventions.length;

      bus.emit('pattern.detected', {
        threadId: 16,
        pattern: 'fake_dissent',
        targetAgent: 'huahua',
      });
      await new Promise((r) => setTimeout(r, 10));

      const newInterventions = interventions.slice(structureCount);
      expect(newInterventions).toHaveLength(1);
      expect(newInterventions[0].targetAgent).toBe('huahua');
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
