import type { EventBus } from '../events/bus.js';
import type { ExecutionTask } from '../types.js';

type SendFn = (agentId: string, content: string, threadId?: number) => Promise<void>;

export class ExecutionReviewer {
  private bus: EventBus;
  private sendFn: SendFn;

  constructor(bus: EventBus, sendFn: SendFn) {
    this.bus = bus;
    this.sendFn = sendFn;
    this.bus.on('execution.completed', (payload) => {
      this.review(payload.threadId, payload.tasks);
    });
  }

  private async review(threadId: number, tasks: ExecutionTask[]): Promise<void> {
    const completed = tasks.filter(t => t.status === 'completed');
    const failed = tasks.filter(t => t.status === 'failed');

    const lines: string[] = ['== Execution Results ==\n'];

    for (const task of completed) {
      lines.push(`✅ ${task.id}: ${task.description}`);
      lines.push(`   Branch: ${task.branch}`);
      lines.push(`   Files: ${task.result?.filesChanged.join(', ') ?? 'none'}`);
      if (task.result?.diff) {
        const diffPreview = task.result.diff.length > 500
          ? task.result.diff.slice(0, 500) + '\n... (truncated)'
          : task.result.diff;
        lines.push(`   Diff:\n\`\`\`\n${diffPreview}\n\`\`\``);
      }
      lines.push('');
    }

    for (const task of failed) {
      lines.push(`❌ ${task.id}: ${task.description} — failed: ${task.error}`);
      lines.push('');
    }

    lines.push(`\n${completed.length} completed, ${failed.length} failed.`);
    lines.push('Human: review the diffs and decide which branches to merge.');

    await this.sendFn('system', lines.join('\n'), threadId);
  }
}
