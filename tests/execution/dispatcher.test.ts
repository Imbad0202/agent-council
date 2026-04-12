import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionDispatcher } from '../../src/execution/dispatcher.js';
import { EventBus } from '../../src/events/bus.js';
import type { ExecutionConfig, LLMProvider, ProviderResponse } from '../../src/types.js';

const TASK_JSON = JSON.stringify({
  tasks: [
    { id: 'task-1', description: 'Implement auth module', assignedAgent: 'agent-a' },
    { id: 'task-2', description: 'Write tests for auth', assignedAgent: 'agent-b' },
  ],
});

function makeProvider(content = TASK_JSON): LLMProvider {
  return {
    name: 'mock',
    chat: vi.fn<[], Promise<ProviderResponse>>().mockResolvedValue({
      content,
      tokensUsed: { input: 10, output: 20 },
    }),
    summarize: vi.fn<[], Promise<string>>().mockResolvedValue(''),
    estimateTokens: vi.fn<[], number>().mockReturnValue(0),
  };
}

const enabledConfig: ExecutionConfig = {
  enabled: true,
  maxConcurrentWorktrees: 4,
  executorTimeoutMs: 60_000,
  autoDispatch: true,
  repoPath: '/tmp/repo',
};

const disabledConfig: ExecutionConfig = {
  ...enabledConfig,
  enabled: false,
};

describe('ExecutionDispatcher', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('decomposes conclusion into tasks and emits execution.dispatched when intent is implementation', async () => {
    const provider = makeProvider();
    new ExecutionDispatcher(bus, enabledConfig, provider);

    const dispatched = new Promise<{ threadId: number; tasks: unknown[] }>((resolve) => {
      bus.on('execution.dispatched', (payload) => resolve(payload));
    });

    bus.emit('deliberation.ended', {
      threadId: 7,
      conclusion: 'Build a full authentication system with JWT.',
      intent: 'implementation',
    });

    const payload = await dispatched;

    expect(payload.threadId).toBe(7);
    expect(payload.tasks).toHaveLength(2);
    expect(payload.tasks[0]).toMatchObject({
      id: 'task-1',
      description: 'Implement auth module',
      assignedAgent: 'agent-a',
      status: 'pending',
      worktreePath: '',
      branch: '',
    });
    expect(payload.tasks[1]).toMatchObject({
      id: 'task-2',
      description: 'Write tests for auth',
      assignedAgent: 'agent-b',
      status: 'pending',
    });
  });

  it('does NOT dispatch for non-implementation intents', async () => {
    const provider = makeProvider();
    new ExecutionDispatcher(bus, enabledConfig, provider);

    let dispatched = false;
    bus.on('execution.dispatched', () => { dispatched = true; });

    for (const intent of ['deliberation', 'quick-answer', 'investigation', 'meta'] as const) {
      bus.emit('deliberation.ended', {
        threadId: 1,
        conclusion: 'Some conclusion.',
        intent,
      });
    }

    // Give a tick for any async handler to resolve
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(dispatched).toBe(false);
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('does NOT dispatch when execution config is disabled', async () => {
    const provider = makeProvider();
    new ExecutionDispatcher(bus, disabledConfig, provider);

    let dispatched = false;
    bus.on('execution.dispatched', () => { dispatched = true; });

    bus.emit('deliberation.ended', {
      threadId: 2,
      conclusion: 'Build a system.',
      intent: 'implementation',
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(dispatched).toBe(false);
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('emits execution.dispatched with empty tasks array when LLM returns invalid JSON', async () => {
    const provider = makeProvider('not-valid-json');
    new ExecutionDispatcher(bus, enabledConfig, provider);

    const dispatched = new Promise<{ tasks: unknown[] }>((resolve) => {
      bus.on('execution.dispatched', (payload) => resolve(payload));
    });

    bus.emit('deliberation.ended', {
      threadId: 3,
      conclusion: 'Do something.',
      intent: 'implementation',
    });

    const payload = await dispatched;
    expect(payload.tasks).toHaveLength(0);
  });
});
