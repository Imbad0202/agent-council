import type { AgentWorker } from '../worker/agent-worker.js';
import type { CouncilConfig, CouncilMessage, AgentRole } from '../types.js';
import { TurnManager } from './turn-manager.js';
import { AntiSycophancyEngine } from '../council/anti-sycophancy.js';
import { assignRoles } from '../council/role-assigner.js';

type SendFn = (agentId: string, content: string) => Promise<void>;

export class GatewayRouter {
  private workers: AgentWorker[];
  private config: CouncilConfig;
  private turnManager: TurnManager;
  private antiSycophancy: AntiSycophancyEngine;
  private conversationHistory: CouncilMessage[] = [];
  private sendFn: SendFn;
  private currentRoles: Record<string, AgentRole> = {};

  constructor(workers: AgentWorker[], config: CouncilConfig, sendFn: SendFn) {
    this.workers = workers;
    this.config = config;
    this.sendFn = sendFn;
    this.turnManager = new TurnManager(config.gateway);
    this.antiSycophancy = new AntiSycophancyEngine(config.antiSycophancy);
  }

  async handleHumanMessage(message: CouncilMessage): Promise<void> {
    this.conversationHistory.push(message);
    this.turnManager.recordHumanTurn();

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
    }

    await this.turnManager.flushQueue(this.sendFn);
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
}
