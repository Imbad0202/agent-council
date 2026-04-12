import type { AgentWorker } from '../worker/agent-worker.js';
import type { CouncilConfig, CouncilMessage, AgentRole, LLMProvider } from '../types.js';
import { TurnManager } from './turn-manager.js';
import { AntiSycophancyEngine } from '../council/anti-sycophancy.js';
import { assignRoles } from '../council/role-assigner.js';
import { MemoryDB } from '../memory/db.js';
import { UsageTracker } from '../memory/tracker.js';
import { SessionLifecycle } from '../memory/lifecycle.js';
import { PatternDetector } from '../council/pattern-detector.js';
import { generateSessionSummary, saveSessionSummary } from '../memory/session-summary.js';
import { MemoryPruner } from '../memory/pruner.js';
import { MemoryConsolidator } from '../memory/consolidator.js';

type SendFn = (agentId: string, content: string) => Promise<void>;

export class GatewayRouter {
  private workers: AgentWorker[];
  private config: CouncilConfig;
  private turnManager: TurnManager;
  private antiSycophancy: AntiSycophancyEngine;
  private conversationHistory: CouncilMessage[] = [];
  private sendFn: SendFn;
  private currentRoles: Record<string, AgentRole> = {};
  private usageTracker: UsageTracker | null = null;
  private lifecycle: SessionLifecycle | null = null;
  private patternDetector: PatternDetector | null = null;
  private memoryDb: MemoryDB | null = null;
  private provider: LLMProvider | null = null;
  private dataDir: string | null = null;
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPatternInjection: { targetAgent: string; prompt: string } | null = null;

  constructor(workers: AgentWorker[], config: CouncilConfig, sendFn: SendFn) {
    this.workers = workers;
    this.config = config;
    this.sendFn = sendFn;
    this.turnManager = new TurnManager(config.gateway);
    this.antiSycophancy = new AntiSycophancyEngine(config.antiSycophancy);
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

  async handleHumanMessage(message: CouncilMessage): Promise<void> {
    this.conversationHistory.push(message);
    this.turnManager.recordHumanTurn();

    // Check for session end keywords
    if (this.lifecycle?.isEndKeyword(message.content)) {
      console.log('[Session] End keyword detected, triggering summary...');
      await this.triggerSessionEnd();
      return;
    }

    // Reset inactivity timer
    this.resetInactivityTimer();

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Turn ${this.turnManager.turnCount}] Human: ${message.content.slice(0, 100)}${message.content.length > 100 ? '...' : ''}`);

    const agentIds = this.workers.map((w) => w.id);
    this.currentRoles = assignRoles(agentIds, message.content, this.config);
    console.log(`[Roles] ${Object.entries(this.currentRoles).map(([id, role]) => `${id}=${role}`).join(', ')}`);

    const responses = await Promise.all(
      this.workers.map(async (worker) => {
        const role = this.currentRoles[worker.id];

        const lastAgentMsg = [...this.conversationHistory]
          .reverse()
          .find((m) => m.role === 'agent' && m.agentId !== worker.id);

        let challengePrompt: string | undefined;
        if (lastAgentMsg) {
          challengePrompt = this.antiSycophancy.generateChallengePrompt(lastAgentMsg);
        }

        const convergencePrompt = this.antiSycophancy.checkConvergence();
        if (convergencePrompt) {
          challengePrompt = challengePrompt
            ? `${challengePrompt}\n\n${convergencePrompt}`
            : convergencePrompt;
        }

        // Add pattern-detected injection if targeting this worker
        if (this.pendingPatternInjection?.targetAgent === worker.id) {
          const patternPrompt = this.pendingPatternInjection.prompt;
          challengePrompt = challengePrompt
            ? `${challengePrompt}\n\n${patternPrompt}`
            : patternPrompt;
          this.pendingPatternInjection = null;
        }

        console.log(`[${worker.id}] Thinking as ${role}...`);
        const response = await worker.respond(this.conversationHistory, role, challengePrompt);
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
        metadata: {
          assignedRole: this.currentRoles[worker.id],
          confidence: response.confidence,
          references: response.references,
        },
      };

      this.conversationHistory.push(agentMsg);
      this.turnManager.recordAgentTurn(worker.id);
      this.turnManager.enqueueResponse(worker.id, response.content);

      const classification = this.antiSycophancy.classifyResponse(response.content);
      this.antiSycophancy.recordClassification(classification);
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

    await this.turnManager.flushQueue(this.sendFn);

    // Anti-pattern detection (Phase 2)
    if (this.patternDetector?.shouldDetect(this.turnManager.turnCount)) {
      const detection = await this.patternDetector.detect(this.conversationHistory);
      if (detection) {
        console.log(`[Pattern] Detected: ${detection.pattern} -> ${detection.targetAgent}`);
        this.pendingPatternInjection = {
          targetAgent: detection.targetAgent,
          prompt: this.patternDetector.getInjectionPrompt(detection.pattern),
        };
      }
    }

    // Check session max turns
    if (this.isSessionMaxReached() && this.lifecycle) {
      console.log('[Session] Max turns reached, triggering summary...');
      await this.triggerSessionEnd();
    }

    console.log(`[Done] Turn ${this.turnManager.turnCount} complete\n`);
  }

  getConversationHistory(): CouncilMessage[] {
    return [...this.conversationHistory];
  }

  isSessionMaxReached(): boolean {
    return this.turnManager.isSessionMaxReached();
  }

  reset(): void {
    this.conversationHistory = [];
    this.turnManager.reset();
    this.antiSycophancy.reset();
  }

  private async triggerSessionEnd(): Promise<void> {
    if (!this.lifecycle || !this.provider || !this.dataDir || !this.memoryDb) return;
    if (this.conversationHistory.length < 2) return;

    const agentIds = this.workers.map((w) => w.id);
    const model = 'claude-opus-4-6';

    const { topic, outcome, confidence } = await this.lifecycle.extractTopicAndOutcome(this.conversationHistory);
    console.log(`[Session] Topic: ${topic}, Outcome: ${outcome}, Confidence: ${confidence}`);

    const summary = await generateSessionSummary(this.conversationHistory, agentIds, this.provider, model);

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

    await this.sendFn('system', `\u{1F4CB} Council \u6458\u8981\uFF1A${topic} \u2014 ${outcome}`);

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

    this.reset();
    console.log('[Session] Session ended and reset.');
  }

  private resetInactivityTimer(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
    }
    if (this.lifecycle && this.config.memory) {
      this.inactivityTimer = setTimeout(async () => {
        console.log('[Session] Inactivity timeout, triggering summary...');
        await this.triggerSessionEnd();
      }, this.config.memory.sessionTimeoutMs);
    }
  }
}
