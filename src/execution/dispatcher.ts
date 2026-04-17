import type { EventBus } from '../events/bus.js';
import type { ExecutionConfig, ExecutionTask, LLMProvider } from '../types.js';
import { DEFAULT_SYSTEM_MODEL } from '../constants.js';

export class ExecutionDispatcher {
  private bus: EventBus;
  private config: ExecutionConfig;
  private provider: LLMProvider;
  private decompositionModel: string;

  constructor(
    bus: EventBus,
    config: ExecutionConfig,
    provider: LLMProvider,
    decompositionModel: string = DEFAULT_SYSTEM_MODEL,
  ) {
    this.bus = bus;
    this.config = config;
    this.provider = provider;
    this.decompositionModel = decompositionModel;
    this.bus.on('deliberation.ended', (payload) => {
      if (payload.intent === 'implementation' && this.config.enabled) {
        this.dispatch(payload.threadId, payload.conclusion);
      }
    });
  }

  private async dispatch(threadId: number, conclusion: string): Promise<void> {
    const tasks = await this.decomposeTasks(conclusion);
    this.bus.emit('execution.dispatched', { threadId, tasks });
  }

  private async decomposeTasks(conclusion: string): Promise<ExecutionTask[]> {
    const response = await this.provider.chat(
      [{ role: 'user', content: `Decompose this implementation plan into discrete tasks:\n\n${conclusion}` }],
      {
        model: this.decompositionModel,
        systemPrompt: `Decompose the implementation conclusion into discrete coding tasks. Each task should be independently implementable. Respond in JSON: {"tasks": [{"id": "task-1", "description": "...", "assignedAgent": "..."}]}. Keep tasks focused and small. Max 5 tasks.`,
        maxTokens: 512,
        temperature: 0.2,
      },
    );
    try {
      const parsed = JSON.parse(response.content) as {
        tasks: Array<{ id: string; description: string; assignedAgent: string }>;
      };
      return parsed.tasks.map((t) => ({
        id: t.id,
        description: t.description,
        assignedAgent: t.assignedAgent,
        worktreePath: '',
        branch: '',
        status: 'pending' as const,
      }));
    } catch {
      return [];
    }
  }
}
