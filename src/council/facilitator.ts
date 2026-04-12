import type { EventBus } from '../events/bus.js';
import type { AgentWorker } from '../worker/agent-worker.js';
import type { FacilitatorAction, CouncilMessage, PatternType } from '../types.js';
import { PATTERN_INJECTION_PROMPTS } from './pattern-prompts.js';

interface FacilitatorDecision {
  action: FacilitatorAction | 'none';
  content: string;
  target_agent: string | null;
}

export class FacilitatorAgent {
  private bus: EventBus;
  private worker: AgentWorker;
  private deliberationHistory: Map<number, CouncilMessage[]> = new Map();

  constructor(bus: EventBus, worker: AgentWorker) {
    this.bus = bus;
    this.worker = worker;

    // On deliberation start: announce structure
    this.bus.on('deliberation.started', (payload) => {
      this.deliberationHistory.set(payload.threadId, []);
      this.announceStructure(payload.threadId, payload.participants, payload.structure);
    });

    // On agent response: record and evaluate whether to intervene
    this.bus.on('agent.responded', (payload) => {
      const history = this.deliberationHistory.get(payload.threadId) ?? [];
      history.push({
        id: `${payload.agentId}-${Date.now()}`,
        role: 'agent',
        agentId: payload.agentId,
        content: payload.response.content,
        timestamp: Date.now(),
        threadId: payload.threadId,
      });
      this.deliberationHistory.set(payload.threadId, history);
      this.evaluateIntervention(payload.threadId);
    });

    // On convergence: decide to challenge or allow
    this.bus.on('convergence.detected', (payload) => {
      this.handleConvergence(payload.threadId, payload.angle);
    });

    // On pattern: issue targeted guidance directly (no LLM call)
    this.bus.on('pattern.detected', (payload) => {
      this.handlePattern(payload.threadId, payload.targetAgent, payload.pattern);
    });

    // Clean up history on deliberation end
    this.bus.on('deliberation.ended', (payload) => {
      this.deliberationHistory.delete(payload.threadId);
    });
  }

  private announceStructure(threadId: number, participants: string[], structure: string): void {
    const participantList = participants.join('、');
    const content = `本次討論開始。參與者：${participantList}。討論模式：${structure}。請各方充分表達觀點，主持人將在必要時介入。`;

    this.bus.emit('facilitator.intervened', {
      threadId,
      action: 'structure',
      content,
    });
  }

  private async evaluateIntervention(threadId: number): Promise<void> {
    const history = this.deliberationHistory.get(threadId) ?? [];

    // Only evaluate after 2+ messages
    if (history.length < 2) return;

    const transcript = history
      .map((m) => `${m.agentId ?? 'Agent'}: ${m.content}`)
      .join('\n\n');

    const evalMessage: CouncilMessage = {
      id: `facilitator-eval-${Date.now()}`,
      role: 'human',
      content: `以下是目前的討論記錄：\n\n${transcript}\n\n請評估是否需要介入。回應 JSON 格式：{"action": "steer"|"challenge"|"summarize"|"escalate"|"end"|"none", "content": "介入內容或空字串", "target_agent": "目標 agent ID 或 null"}`,
      timestamp: Date.now(),
      threadId,
    };

    try {
      const response = await this.worker.respond([evalMessage], 'synthesizer');
      const decision = this.parseDecision(response.content);

      if (decision.action !== 'none') {
        this.bus.emit('facilitator.intervened', {
          threadId,
          action: decision.action as FacilitatorAction,
          content: decision.content,
          ...(decision.target_agent ? { targetAgent: decision.target_agent } : {}),
        });
      }
    } catch {
      // Evaluation failed — skip intervention silently
    }
  }

  private async handleConvergence(threadId: number, angle: string): Promise<void> {
    const convergenceMessage: CouncilMessage = {
      id: `facilitator-convergence-${Date.now()}`,
      role: 'human',
      content: `偵測到共識收斂（角度：${angle}）。這是真正的共識還是懶惰性同意？請決定是否要挑戰這個共識。回應 JSON 格式：{"action": "challenge"|"none", "content": "挑戰內容或空字串", "target_agent": null}`,
      timestamp: Date.now(),
      threadId,
    };

    try {
      const response = await this.worker.respond([convergenceMessage], 'synthesizer');
      const decision = this.parseDecision(response.content);

      if (decision.action !== 'none') {
        this.bus.emit('facilitator.intervened', {
          threadId,
          action: decision.action as FacilitatorAction,
          content: decision.content,
          ...(decision.target_agent ? { targetAgent: decision.target_agent } : {}),
        });
      }
    } catch {
      // Convergence handling failed — skip silently
    }
  }

  private handlePattern(threadId: number, targetAgent: string, pattern: PatternType): void {
    const content = PATTERN_INJECTION_PROMPTS[pattern];

    this.bus.emit('facilitator.intervened', {
      threadId,
      action: 'challenge',
      content,
      targetAgent,
    });
  }

  private parseDecision(responseContent: string): FacilitatorDecision {
    // Try to extract JSON from the response (may be wrapped in markdown)
    const jsonMatch = responseContent.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as Partial<FacilitatorDecision>;
        return {
          action: parsed.action ?? 'none',
          content: parsed.content ?? '',
          target_agent: parsed.target_agent ?? null,
        };
      } catch {
        // Fall through to default
      }
    }

    return { action: 'none', content: '', target_agent: null };
  }
}
