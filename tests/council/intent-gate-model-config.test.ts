import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../src/events/bus.js';
import { IntentGate } from '../../src/council/intent-gate.js';
import type { LLMProvider, ProviderMessage, ChatOptions } from '../../src/types.js';

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

function makeMessage(content: string) {
  return { id: 'msg-1', role: 'human' as const, content, timestamp: Date.now() };
}

describe('IntentGate — classificationModel config', () => {
  it('uses classificationModel passed in constructor for LLM fallback', async () => {
    const provider = createMockProvider('{"intent": "deliberation", "complexity": "medium"}');
    const chatSpy = vi.spyOn(provider, 'chat');
    const bus = new EventBus();
    new IntentGate(bus, provider, 'claude-opus-4-7');
    const handler = vi.fn();
    bus.on('intent.classified', handler);

    const ambiguous = 'Broad question with no keywords that will fall through to the LLM layer for sure.';
    bus.emit('message.received', { message: makeMessage(ambiguous), threadId: 1 });
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());

    expect(chatSpy).toHaveBeenCalled();
    const options = chatSpy.mock.calls[0][1];
    expect(options.model).toBe('claude-opus-4-7');
  });

  it('defaults to claude-haiku-4-5-20251001 when no model is passed (backward compat)', async () => {
    const provider = createMockProvider('{"intent": "deliberation", "complexity": "medium"}');
    const chatSpy = vi.spyOn(provider, 'chat');
    const bus = new EventBus();
    new IntentGate(bus, provider);
    const handler = vi.fn();
    bus.on('intent.classified', handler);

    const ambiguous = 'Broad question with no keywords that will fall through to the LLM layer for sure.';
    bus.emit('message.received', { message: makeMessage(ambiguous), threadId: 1 });
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());

    const options = chatSpy.mock.calls[0][1];
    expect(options.model).toBe('claude-haiku-4-5-20251001');
  });
});
