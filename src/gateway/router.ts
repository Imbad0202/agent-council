import type { AgentWorker } from '../worker/agent-worker.js';
import type { CouncilConfig, CouncilMessage, AgentRole, LLMProvider } from '../types.js';
import { TurnManager } from './turn-manager.js';
import { AntiSycophancyEngine } from '../council/anti-sycophancy.js';
import { assignRoles } from '../council/role-assigner.js';
import { ParticipationManager } from '../council/participation.js';
import { MemoryDB } from '../memory/db.js';
import { UsageTracker } from '../memory/tracker.js';
import { SessionLifecycle } from '../memory/lifecycle.js';
import { PatternDetector } from '../council/pattern-detector.js';
import { generateSessionSummary, saveSessionSummary } from '../memory/session-summary.js';
import { MemoryPruner } from '../memory/pruner.js';
import { MemoryConsolidator } from '../memory/consolidator.js';

type SendFn = (agentId: string, content: string, threadId?: number) => Promise<void>;

interface SessionState {
  conversationHistory: CouncilMessage[];
  currentParticipants: string[];
  turnManager: TurnManager;
  antiSycophancy: AntiSycophancyEngine;
  pendingPatternInjection: { targetAgent: string; prompt: string } | null;
  inactivityTimer: ReturnType<typeof setTimeout> | null;
}

export class GatewayRouter {
  private workers: AgentWorker[];
  private config: CouncilConfig;
  private sessions: Map<number, SessionState> = new Map();
  private sendFn: SendFn;
  private currentRoles: Record<string, AgentRole> = {};
  private usageTracker: UsageTracker | null = null;
  private lifecycle: SessionLifecycle | null = null;
  private patternDetector: PatternDetector | null = null;
  private memoryDb: MemoryDB | null = null;
  private provider: LLMProvider | null = null;
  private dataDir: string | null = null;
  private participationManager: ParticipationManager | null = null;

  constructor(workers: AgentWorker[], config: CouncilConfig, sendFn: SendFn) {
    this.workers = workers;
    this.config = config;
    this.sendFn = sendFn;
  }

  setPhase2(deps: {
    db: MemoryDB;
    tracker: UsageTracker;
    lifecycle: SessionLifecycle;
    patternDetector: PatternDetector;
    provider: LLMProvider;
    dataDir: string;
  }): void {
    this.memoryDb = deps.db;
    this.usageTracker = deps.tracker;
    this.lifecycle = deps.lifecycle;
    this.patternDetector = deps.patternDetector;
    this.provider = deps.provider;
    this.dataDir = deps.dataDir;
  }

  setParticipation(manager: ParticipationManager): void {
    this.participationManager = manager;
  }

  private getSession(threadId: number): SessionState {
    if (!this.sessions.has(threadId)) {
      this.sessions.set(threadId, {
        conversationHistory: [],
        currentParticipants: this.workers.map((w) => w.id),
        turnManager: new TurnManager(this.config.gateway),
        antiSycophancy: new AntiSycophancyEngine(this.config.antiSycophancy),
        pendingPatternInjection: null,
        inactivityTimer: null,
      });
    }
    return this.sessions.get(threadId)!;
  }

  async handleHumanMessage(message: CouncilMessage): Promise<void> {
    const threadId = message.threadId ?? 0;
    const session = this.getSession(threadId);

    session.conversationHistory.push(message);
    session.turnManager.recordHumanTurn();

    // Check for session end keywords
    if (this.lifecycle?.isEndKeyword(message.content)) {
      console.log('[Session] End keyword detected, triggering summary...');
      await this.triggerSessionEnd(threadId);
      return;
    }

    // Reset inactivity timer for this session
    this.resetInactivityTimer(threadId);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Turn ${session.turnManager.turnCount}] Human: ${message.content.slice(0, 100)}${message.content.length > 100 ? '...' : ''}`);

    // Select participants for this turn
    let activeWorkers = this.workers;
    if (this.participationManager) {
      const changes = this.participationManager.detectRecruitment(
        message.content,
        session.currentParticipants,
        {}, // TODO: track skip counts per session
      );

      if (changes.joining.length > 0) {
        for (const id of changes.joining) {
          session.currentParticipants.push(id);
          if (this.config.participation?.recruitmentMessage) {
            const name = this.workers.find((w) => w.id === id)?.name ?? id;
            await this.sendFn('system', `\u{1F504} ${name} \u52A0\u5165\u4E86\u9019\u5834\u8A0E\u8AD6`, threadId);
          }
        }
      }

      if (changes.leaving.length > 0) {
        for (const id of changes.leaving) {
          session.currentParticipants = session.currentParticipants.filter((p) => p !== id);
          if (this.config.participation?.recruitmentMessage) {
            const name = this.workers.find((w) => w.id === id)?.name ?? id;
            await this.sendFn('system', `\u{1F44B} ${name} \u9000\u51FA\u4E86\u9019\u5834\u8A0E\u8AD6`, threadId);
          }
        }
      }

      activeWorkers = this.workers.filter((w) => session.currentParticipants.includes(w.id));
    }

    const agentIds = activeWorkers.map((w) => w.id);
    this.currentRoles = assignRoles(agentIds, message.content, this.config);
    console.log(`[Roles] ${Object.entries(this.currentRoles).map(([id, role]) => `${id}=${role}`).join(', ')}`);

    const responses = await Promise.all(
      activeWorkers.map(async (worker) => {
        const role = this.currentRoles[worker.id];

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

        console.log(`[${worker.id}] Thinking as ${role}...`);
        const response = await worker.respond(session.conversationHistory, role, challengePrompt);
        console.log(`[${worker.id}] Response: ${response.content.slice(0, 80)}... (${response.tokensUsed.input}+${response.tokensUsed.output} tokens)`);
        return { worker, response };
      }),
    );

    for (const { worker, response } of responses) {
      if (response.skip) {
        console.log(`[${worker.id}] Skipped: ${response.skipReason ?? 'no reason'}`);
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
          assignedRole: this.currentRoles[worker.id],
          confidence: response.confidence,
          references: response.references,
        },
      };

      session.conversationHistory.push(agentMsg);
      session.turnManager.recordAgentTurn(worker.id);
      session.turnManager.enqueueResponse(worker.id, response.content);

      const classification = session.antiSycophancy.classifyResponse(response.content);
      session.antiSycophancy.recordClassification(classification);
      console.log(`[${worker.id}] Classification: ${classification}`);

      // Track memory references (Phase 2)
      if (this.usageTracker) {
        const refs = this.usageTracker.extractReferences(response.content);
        if (refs.length > 0) {
          this.usageTracker.trackReferences(refs);
          console.log(`[${worker.id}] References: ${refs.join(', ')}`);
        }
      }
    }

    await session.turnManager.flushQueue(async (agentId, content) => {
      await this.sendFn(agentId, content, threadId);
    });

    // Anti-pattern detection (Phase 2)
    if (this.patternDetector?.shouldDetect(session.turnManager.turnCount)) {
      const detection = await this.patternDetector.detect(session.conversationHistory);
      if (detection) {
        console.log(`[Pattern] Detected: ${detection.pattern} -> ${detection.targetAgent}`);
        session.pendingPatternInjection = {
          targetAgent: detection.targetAgent,
          prompt: this.patternDetector.getInjectionPrompt(detection.pattern),
        };
      }
    }

    // Check session max turns
    if (this.isSessionMaxReached(threadId) && this.lifecycle) {
      console.log('[Session] Max turns reached, triggering summary...');
      await this.triggerSessionEnd(threadId);
    }

    console.log(`[Done] Turn ${session.turnManager.turnCount} complete\n`);
  }

  getConversationHistory(threadId?: number): CouncilMessage[] {
    const session = this.sessions.get(threadId ?? 0);
    return session ? [...session.conversationHistory] : [];
  }

  isSessionMaxReached(threadId?: number): boolean {
    const session = this.sessions.get(threadId ?? 0);
    return session ? session.turnManager.isSessionMaxReached() : false;
  }

  reset(): void {
    for (const session of this.sessions.values()) {
      if (session.inactivityTimer) clearTimeout(session.inactivityTimer);
    }
    this.sessions.clear();
  }

  private async triggerSessionEnd(threadId: number): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    if (!this.lifecycle || !this.provider || !this.dataDir || !this.memoryDb) return;
    if (session.conversationHistory.length < 2) return;

    const agentIds = this.workers.map((w) => w.id);
    const model = 'claude-opus-4-6';

    const { topic, outcome, confidence } = await this.lifecycle.extractTopicAndOutcome(session.conversationHistory);
    console.log(`[Session] Topic: ${topic}, Outcome: ${outcome}, Confidence: ${confidence}`);

    const summary = await generateSessionSummary(session.conversationHistory, agentIds, this.provider, model);

    const date = new Date().toISOString().slice(0, 10);

    for (const agentId of agentIds) {
      saveSessionSummary(this.dataDir, [agentId], summary, topic);

      const filename = `council-session-${date}-${topic}.md`;
      const id = `${agentId}/sessions/${filename}`;

      this.memoryDb.insertMemory({
        id,
        agentId,
        type: 'session',
        topic,
        confidence,
        outcome,
        usageCount: 0,
        lastUsed: null,
        createdAt: date,
        contentPreview: summary.slice(0, 200),
      });
    }

    await this.sendFn('system', `\u{1F4CB} Council \u6458\u8981\uFF1A${topic} \u2014 ${outcome}`, threadId);

    // Check consolidation
    if (this.config.memory) {
      const consolidator = new MemoryConsolidator(this.memoryDb, this.dataDir, this.provider, model);
      for (const agentId of agentIds) {
        const topics = consolidator.getConsolidatableTopics(agentId, this.config.memory.consolidationThreshold);
        for (const t of topics) {
          console.log(`[Consolidation] Consolidating ${agentId}/${t}...`);
          await consolidator.consolidate(agentId, t);
        }
      }

      // Check pruning
      const pruner = new MemoryPruner(this.memoryDb, this.dataDir);
      for (const agentId of agentIds) {
        const count = this.memoryDb.countActiveMemories(agentId);
        if (count > this.config.memory.archiveThreshold) {
          console.log(`[Pruning] ${agentId} has ${count} memories, pruning...`);
          pruner.archiveMemories(agentId, this.config.memory.archiveBottomPercent);
        }
      }
    }

    this.sessions.delete(threadId);
    console.log('[Session] Session ended and reset.');
  }

  private resetInactivityTimer(threadId: number): void {
    const session = this.sessions.get(threadId);
    if (!session) return;
    if (session.inactivityTimer) {
      clearTimeout(session.inactivityTimer);
    }
    if (this.lifecycle && this.config.memory) {
      session.inactivityTimer = setTimeout(async () => {
        console.log('[Session] Inactivity timeout, triggering summary...');
        await this.triggerSessionEnd(threadId);
      }, this.config.memory.sessionTimeoutMs);
    }
  }
}
