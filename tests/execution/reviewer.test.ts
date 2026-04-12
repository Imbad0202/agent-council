import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionReviewer } from '../../src/execution/reviewer.js';
import { EventBus } from '../../src/events/bus.js';
import type { ExecutionTask } from '../../src/types.js';

describe('ExecutionReviewer', () => {
  let bus: EventBus;
  let reviewer: ExecutionReviewer;
  const sendFn = vi.fn();

  beforeEach(() => {
    bus = new EventBus();
    reviewer = new ExecutionReviewer(bus, sendFn);
    vi.clearAllMocks();
  });

  it('sends review summary on execution.completed with completed tasks', async () => {
    const tasks: ExecutionTask[] = [{
      id: 'task-1', description: 'Add retry', assignedAgent: 'huahua',
      worktreePath: '/tmp/wt1', branch: 'council/task-1', status: 'completed',
      result: { diff: '+ function retry() {}', filesChanged: ['src/retry.ts'], commitHash: 'abc123' },
    }];
    bus.emit('execution.completed', { threadId: 1, tasks, diffs: ['+ function retry() {}'] });
    await vi.waitFor(() => expect(sendFn).toHaveBeenCalled());
    expect(sendFn).toHaveBeenCalledWith('system', expect.stringContaining('task-1'), 1);
    expect(sendFn).toHaveBeenCalledWith('system', expect.stringContaining('1 completed, 0 failed'), 1);
  });

  it('reports failed tasks', async () => {
    const tasks: ExecutionTask[] = [{
      id: 'task-2', description: 'Something', assignedAgent: 'binbin',
      worktreePath: '/tmp/wt2', branch: 'council/task-2', status: 'failed',
      error: 'LLM timeout',
    }];
    bus.emit('execution.completed', { threadId: 1, tasks, diffs: [] });
    await vi.waitFor(() => expect(sendFn).toHaveBeenCalled());
    expect(sendFn).toHaveBeenCalledWith('system', expect.stringContaining('failed'), 1);
    expect(sendFn).toHaveBeenCalledWith('system', expect.stringContaining('0 completed, 1 failed'), 1);
  });

  it('truncates long diffs', async () => {
    const longDiff = 'a'.repeat(1000);
    const tasks: ExecutionTask[] = [{
      id: 'task-3', description: 'Big change', assignedAgent: 'huahua',
      worktreePath: '/tmp/wt3', branch: 'council/task-3', status: 'completed',
      result: { diff: longDiff, filesChanged: ['big.ts'], commitHash: 'def456' },
    }];
    bus.emit('execution.completed', { threadId: 1, tasks, diffs: [longDiff] });
    await vi.waitFor(() => expect(sendFn).toHaveBeenCalled());
    expect(sendFn).toHaveBeenCalledWith('system', expect.stringContaining('truncated'), 1);
  });
});
