import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../src/events/bus.js';
import { ExecutionDispatcher } from '../../src/execution/dispatcher.js';
import type { LLMProvider, ProviderMessage, ChatOptions, ExecutionConfig } from '../../src/types.js';

function createMockProvider(responseContent: string): LLMProvider {
  return {
    name: 'mock',
    async chat(_messages: ProviderMessage[], _options: ChatOptions) {
      return { content: responseContent, tokensUsed: { input: 0, output: 0 } };
    },
    async summarize() { return ''; },
    estimateTokens() { return 0; },
  };
}

const execConfig: ExecutionConfig = {
  enabled: true,
  maxConcurrentWorktrees: 1,
  executorTimeoutMs: 10000,
  autoDispatch: true,
  repoPath: '.',
};

describe('ExecutionDispatcher — decompositionModel config', () => {
  it('uses decompositionModel passed in constructor', async () => {
    const provider = createMockProvider('{"tasks": [{"id":"t1","description":"do x","assignedAgent":"a1"}]}');
    const chatSpy = vi.spyOn(provider, 'chat');
    const bus = new EventBus();
    new ExecutionDispatcher(bus, execConfig, provider, 'claude-opus-4-7');
    const dispatchedHandler = vi.fn();
    bus.on('execution.dispatched', dispatchedHandler);

    bus.emit('deliberation.ended', { threadId: 1, conclusion: 'build x', intent: 'implementation' });
    await vi.waitFor(() => expect(dispatchedHandler).toHaveBeenCalled());

    const options = chatSpy.mock.calls[0][1];
    expect(options.model).toBe('claude-opus-4-7');
  });

  it('defaults to claude-sonnet-4-6 when no model is passed', async () => {
    const provider = createMockProvider('{"tasks": [{"id":"t1","description":"do x","assignedAgent":"a1"}]}');
    const chatSpy = vi.spyOn(provider, 'chat');
    const bus = new EventBus();
    new ExecutionDispatcher(bus, execConfig, provider);
    const dispatchedHandler = vi.fn();
    bus.on('execution.dispatched', dispatchedHandler);

    bus.emit('deliberation.ended', { threadId: 1, conclusion: 'build x', intent: 'implementation' });
    await vi.waitFor(() => expect(dispatchedHandler).toHaveBeenCalled());

    const options = chatSpy.mock.calls[0][1];
    expect(options.model).toBe('claude-sonnet-4-6');
  });
});
