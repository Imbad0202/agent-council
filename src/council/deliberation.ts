import type { EventBus } from '../events/bus.js';
import type { AgentWorker } from '../worker/agent-worker.js';
import type {
  CouncilConfig,
  CouncilMessage,
  AgentRole,
  Complexity,
  IntentType,
  ResponseClassification,
  ProviderResponse,
} from '../types.js';
import { TurnManager } from '../gateway/turn-manager.js';
import { AntiSycophancyEngine } from './anti-sycophancy.js';
import { assignRoles } from './role-assigner.js';
import { PATTERN_INJECTION_PROMPTS } from './pattern-prompts.js';
import { parseSneakyTrailer, formatDebrief, pickSneakyTarget, type DebriefRecord } from './sneaky-prover.js';
import { BlindReviewStore, buildScoringKeyboard } from './blind-review.js';

type SendFn = (agentId: string, content: string, threadId?: number) => Promise<void>;
type SendKeyboardFn = (agentId: string, content: string, keyboard: import('grammy').InlineKeyboard, threadId?: number) => Promise<void>;

interface SessionState {
  conversationHistory: CouncilMessage[];
  currentParticipants: string[];
  turnManager: TurnManager;
  antiSycophancy: AntiSycophancyEngine;
  pendingPatternInjection: { targetAgent: string; prompt: string } | null;
}

export class DeliberationHandler {
  private bus: EventBus;
  private workers: AgentWorker[];
  private facilitatorWorker: AgentWorker | undefined;
  private config: CouncilConfig;
  private sendFn: SendFn;
  private sendKeyboardFn: SendKeyboardFn | undefined;
  private blindReviewStore = new BlindReviewStore();
  private sessions: Map<number, SessionState> = new Map();

  public getBlindReviewStore(): BlindReviewStore {
    return this.blindReviewStore;
  }

  constructor(bus: EventBus, workers: AgentWorker[], config: CouncilConfig, sendFn: SendFn, facilitatorWorker?: AgentWorker, sendKeyboardFn?: SendKeyboardFn) {
    this.bus = bus;
    this.workers = workers;
    this.facilitatorWorker = facilitatorWorker;
    this.config = config;
    this.sendFn = sendFn;
    this.sendKeyboardFn = sendKeyboardFn;

    // Subscribe to intent.classified — skip 'meta' intent
    this.bus.on('intent.classified', (payload) => {
      if (payload.intent === 'meta') return;
      this.runDeliberation(payload.threadId, payload.message, payload.intent, payload.complexity);
    });

    // Subscribe to facilitator.intervened — only add non-structure messages to history
    // Structure announcements (opening messages) are display-only, not part of deliberation context
    this.bus.on('facilitator.intervened', (payload) => {
      if (payload.action === 'structure') return;

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
    const stressTestMode = message?.stressTest === true;
    const debriefs: DebriefRecord[] = [];
    let currentRoles = assignRoles(
      agentIds,
      message.content,
      this.config,
      undefined,
      stressTestMode ? { allowSneaky: true } : undefined,
    );
    if (stressTestMode && Object.keys(currentRoles).length >= 2) {
      const targetAgentId = pickSneakyTarget(Object.keys(currentRoles));
      currentRoles[targetAgentId] = 'sneaky-prover';
    }

    const blindReviewMode = message?.blindReview === true;
    let blindCodes: Map<string, string> | undefined;
    if (blindReviewMode && agentIds.length >= 2) {
      const rolesMap = new Map(Object.entries(currentRoles));
      const session = this.blindReviewStore.create(threadId, agentIds, rolesMap);
      if ('error' in session) {
        // The first available bot is fine — we just need to send the error somewhere
        const fallbackId = agentIds[0];
        await this.sendFn(fallbackId, `❌ ${session.error}. Use /cancelreview to end the previous round.`, threadId);
        return;
      }
      blindCodes = session.codeToAgentId;
    }

    // Emit deliberation.started
    this.bus.emit('deliberation.started', {
      threadId,
      participants: agentIds,
      roles: currentRoles,
      structure: 'free',
    });

    // Sequential deliberation: first agent responds to human, second agent responds to both
    const responses: Array<{ worker: AgentWorker; role: AgentRole; response: ProviderResponse }> = [];

    for (const worker of activeWorkers) {
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

      // Strip sneaky-prover trailer before any broadcast or storage
      let storedContent = response.content;
      if (role === 'sneaky-prover') {
        const parsed = parseSneakyTrailer(response.content);
        if (parsed) {
          storedContent = parsed.bodyWithoutTrailer;
          debriefs.push({ agentId: worker.id, kind: parsed.kind, debrief: parsed.debrief });
        } else {
          debriefs.push({
            agentId: worker.id,
            kind: 'missing-trailer',
            debrief: 'Sneaky-prover response had no trailer; planted error not declared',
          });
        }
      }

      if (!response.skip) {
        const agentMsg: CouncilMessage = {
          id: `agent-${worker.id}-${Date.now()}`,
          role: 'agent',
          agentId: worker.id,
          content: storedContent,
          timestamp: Date.now(),
          threadId,
          metadata: {
            assignedRole: currentRoles[worker.id],
            confidence: response.confidence,
            references: response.references,
          },
        };

        // Push to history BEFORE next agent — so next agent sees this response
        session.conversationHistory.push(agentMsg);
        session.turnManager.recordAgentTurn(worker.id);

        // Send to Telegram immediately
        if (blindCodes) {
          const code = [...blindCodes.entries()].find(([, agentId]) => agentId === worker.id)?.[0];
          const labeledContent = code ? `[${code}]:\n${storedContent}` : storedContent;
          await this.sendFn(agentIds[0], labeledContent, threadId);
        } else {
          await this.sendFn(worker.id, storedContent, threadId);
        }

        const classification = session.antiSycophancy.classifyResponse(storedContent);
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

      const responseForStorage =
        role === 'sneaky-prover' && storedContent !== response.content
          ? { ...response, content: storedContent }
          : response;
      responses.push({ worker, role, response: responseForStorage });
    }

    // Broadcast debrief if stress-test round produced sneaky-prover entries
    if (debriefs.length > 0) {
      const debriefMessage = debriefs.map(formatDebrief).join('\n');
      await this.sendFn('system-debrief', debriefMessage, threadId);
    }

    // Blind-review: post scoring keyboard after all responses are in
    if (blindCodes && blindCodes.size >= 2 && this.sendKeyboardFn) {
      const codes = [...blindCodes.keys()];
      const keyboard = buildScoringKeyboard(codes);
      await this.sendKeyboardFn(
        agentIds[0],
        'Score each agent 1-5 based on their contribution above. Identities will be revealed once all are scored.',
        keyboard,
        threadId,
      );
      this.bus.emit('blind-review.started', { threadId, codes });
    }

    // Facilitator summary — ask if user wants another round
    if (!this.facilitatorWorker) {
      // No facilitator, just end
      const lastResponse = responses.filter((r) => !r.response.skip).pop();
      const conclusion = lastResponse
        ? lastResponse.response.content.slice(0, 200)
        : 'No responses generated';
      this.bus.emit('deliberation.ended', { threadId, conclusion, intent });
      return;
    }

    // Build summary prompt for facilitator
    const recentAgentMsgs = responses
      .filter((r) => !r.response.skip)
      .map((r) => `${r.worker.name}: ${r.response.content}`)
      .join('\n\n---\n\n');

    const summaryMsg: CouncilMessage = {
      id: `facilitator-summary-${Date.now()}`,
      role: 'human',
      content: `以下是本輪討論：\n\n${recentAgentMsgs}\n\n請用 200 字以內總結雙方觀點的交集與分歧，然後問用戶是否要再進行一輪辯論。用繁體中文回應。`,
      timestamp: Date.now(),
      threadId,
    };

    try {
      const summaryResponse = await this.facilitatorWorker.respond([summaryMsg], 'synthesizer', undefined, complexity);
      if (summaryResponse.content.trim()) {
        await this.sendFn('facilitator', summaryResponse.content, threadId);
      }
    } catch {
      // Facilitator summary failed — skip silently
    }

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
