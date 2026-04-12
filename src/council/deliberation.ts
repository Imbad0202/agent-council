import type { EventBus } from '../events/bus.js';
import type { AgentWorker } from '../worker/agent-worker.js';
import type {
  CouncilConfig,
  CouncilMessage,
  AgentRole,
  Complexity,
  IntentType,
  PatternType,
  ResponseClassification,
} from '../types.js';
import { TurnManager } from '../gateway/turn-manager.js';
import { AntiSycophancyEngine } from './anti-sycophancy.js';
import { assignRoles } from './role-assigner.js';

type SendFn = (agentId: string, content: string, threadId?: number) => Promise<void>;

interface SessionState {
  conversationHistory: CouncilMessage[];
  currentParticipants: string[];
  turnManager: TurnManager;
  antiSycophancy: AntiSycophancyEngine;
  pendingPatternInjection: { targetAgent: string; prompt: string } | null;
}

const PATTERN_INJECTION_PROMPTS: Record<PatternType, string> = {
  mirror: '你的回覆跟對方高度重疊。提出一個對方沒提到的面向。',
  fake_dissent: '你聲稱不同意但結論一致。什麼情況下你會得出不同結論？',
  quick_surrender: '你在一次反對後就改變立場。那個反對真的推翻了你的論點嗎？',
  authority_submission: '你在人類表態後改變了觀點。請基於論點本身評估，不是因為人類同意了對方。',
};

export class DeliberationHandler {
  private bus: EventBus;
  private workers: AgentWorker[];
  private config: CouncilConfig;
  private sendFn: SendFn;
  private sessions: Map<number, SessionState> = new Map();

  constructor(bus: EventBus, workers: AgentWorker[], config: CouncilConfig, sendFn: SendFn) {
    this.bus = bus;
    this.workers = workers;
    this.config = config;
    this.sendFn = sendFn;

    // Subscribe to intent.classified — skip 'meta' intent
    this.bus.on('intent.classified', (payload) => {
      if (payload.intent === 'meta') return;
      this.runDeliberation(payload.threadId, payload.message, payload.intent, payload.complexity);
    });

    // Subscribe to facilitator.intervened — add facilitator messages to history
    this.bus.on('facilitator.intervened', (payload) => {
      const session = this.sessions.get(payload.threadId);
      if (!session) return;

      const facilitatorMsg: CouncilMessage = {
        id: `facilitator-${Date.now()}`,
        role: 'agent',
        agentId: 'facilitator',
        content: payload.content,
        timestamp: Date.now(),
        threadId: payload.threadId,
        metadata: {
          assignedRole: 'synthesizer',
        },
      };
      session.conversationHistory.push(facilitatorMsg);
    });

    // Subscribe to pattern.detected — store pending injection
    this.bus.on('pattern.detected', (payload) => {
      const session = this.sessions.get(payload.threadId);
      if (!session) return;

      session.pendingPatternInjection = {
        targetAgent: payload.targetAgent,
        prompt: PATTERN_INJECTION_PROMPTS[payload.pattern],
      };
    });
  }

  private getSession(threadId: number): SessionState {
    if (!this.sessions.has(threadId)) {
      this.sessions.set(threadId, {
        conversationHistory: [],
        currentParticipants: this.workers.map((w) => w.id),
        turnManager: new TurnManager(this.config.gateway),
        antiSycophancy: new AntiSycophancyEngine(this.config.antiSycophancy),
        pendingPatternInjection: null,
      });
    }
    return this.sessions.get(threadId)!;
  }

  private async runDeliberation(
    threadId: number,
    message: CouncilMessage,
    intent: IntentType,
    complexity: Complexity,
  ): Promise<void> {
    const session = this.getSession(threadId);

    // Push human message to history
    session.conversationHistory.push(message);
    session.turnManager.recordHumanTurn();

    // Determine active workers based on current participants
    const activeWorkers = this.workers.filter((w) =>
      session.currentParticipants.includes(w.id),
    );

    // Assign roles
    const agentIds = activeWorkers.map((w) => w.id);
    const currentRoles = assignRoles(agentIds, message.content, this.config);

    // Emit deliberation.started
    this.bus.emit('deliberation.started', {
      threadId,
      participants: agentIds,
      roles: currentRoles,
      structure: 'free',
    });

    // Generate agent responses (parallel LLM calls)
    const responses = await Promise.all(
      activeWorkers.map(async (worker) => {
        const role = currentRoles[worker.id];

        // Emit agent.responding
        this.bus.emit('agent.responding', { threadId, agentId: worker.id, role });

        // Build challenge prompt from anti-sycophancy
        const lastAgentMsg = [...session.conversationHistory]
          .reverse()
          .find((m) => m.role === 'agent' && m.agentId !== worker.id);

        let challengePrompt: string | undefined;
        if (lastAgentMsg) {
          challengePrompt = session.antiSycophancy.generateChallengePrompt(lastAgentMsg);
        }

        const convergencePrompt = session.antiSycophancy.checkConvergence();
        if (convergencePrompt) {
          challengePrompt = challengePrompt
            ? `${challengePrompt}\n\n${convergencePrompt}`
            : convergencePrompt;
        }

        // Add pattern-detected injection if targeting this worker
        if (session.pendingPatternInjection?.targetAgent === worker.id) {
          const patternPrompt = session.pendingPatternInjection.prompt;
          challengePrompt = challengePrompt
            ? `${challengePrompt}\n\n${patternPrompt}`
            : patternPrompt;
          session.pendingPatternInjection = null;
        }

        const response = await worker.respond(
          session.conversationHistory,
          role,
          challengePrompt,
          complexity,
        );

        return { worker, role, response };
      }),
    );

    // Process responses sequentially: push to history, classify, emit, send
    for (const { worker, role, response } of responses) {
      if (response.skip) {
        continue;
      }

      const agentMsg: CouncilMessage = {
        id: `agent-${worker.id}-${Date.now()}`,
        role: 'agent',
        agentId: worker.id,
        content: response.content,
        timestamp: Date.now(),
        threadId,
        metadata: {
          assignedRole: currentRoles[worker.id],
          confidence: response.confidence,
          references: response.references,
        },
      };

      session.conversationHistory.push(agentMsg);
      session.turnManager.recordAgentTurn(worker.id);
      session.turnManager.enqueueResponse(worker.id, response.content);

      const classification = session.antiSycophancy.classifyResponse(response.content);
      session.antiSycophancy.recordClassification(classification);

      // Emit agent.responded
      this.bus.emit('agent.responded', {
        threadId,
        agentId: worker.id,
        response,
        role,
        classification,
      });
    }

    // Flush queue — send to user via sendFn
    await session.turnManager.flushQueue(async (agentId, content) => {
      await this.sendFn(agentId, content, threadId);
    });

    // Build conclusion from last agent response
    const lastResponse = responses.filter((r) => !r.response.skip).pop();
    const conclusion = lastResponse
      ? lastResponse.response.content.slice(0, 200)
      : 'No responses generated';

    // Emit deliberation.ended
    this.bus.emit('deliberation.ended', {
      threadId,
      conclusion,
      intent,
    });
  }
}
