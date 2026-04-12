import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../../src/events/bus.js';
import { IntentGate } from '../../src/council/intent-gate.js';
import type { LLMProvider, ProviderMessage, ChatOptions } from '../../src/types.js';

function createMockProvider(responseContent: string): LLMProvider {
  return {
    name: 'mock',
    async chat(_messages: ProviderMessage[], _options: ChatOptions) {
      return {
        content: responseContent,
        tokensUsed: { input: 0, output: 0 },
      };
    },
    async summarize(_text: string, _model: string) {
      return '';
    },
    estimateTokens(_messages: ProviderMessage[]) {
      return 0;
    },
  };
}

function makeMessage(content: string) {
  return {
    id: 'msg-test',
    role: 'human' as const,
    content,
    timestamp: Date.now(),
  };
}

describe('IntentGate', () => {
  let bus: EventBus;
  let mockProvider: LLMProvider;

  beforeEach(() => {
    bus = new EventBus();
    mockProvider = createMockProvider('{"intent": "deliberation", "complexity": "medium"}');
  });

  it('classifies meta intent from end keywords (結束)', async () => {
    const gate = new IntentGate(bus, mockProvider);
    const handler = vi.fn();
    bus.on('intent.classified', handler);

    bus.emit('message.received', { message: makeMessage('好了我覺得可以結束了'), threadId: 1 });

    await vi.waitFor(() => expect(handler).toHaveBeenCalled());

    const payload = handler.mock.calls[0][0];
    expect(payload.intent).toBe('meta');
    expect(payload.threadId).toBe(1);
  });

  it('classifies implementation intent from keywords (幫我實作 retry logic)', async () => {
    const gate = new IntentGate(bus, mockProvider);
    const handler = vi.fn();
    bus.on('intent.classified', handler);

    bus.emit('message.received', { message: makeMessage('幫我實作 retry logic'), threadId: 2 });

    await vi.waitFor(() => expect(handler).toHaveBeenCalled());

    const payload = handler.mock.calls[0][0];
    expect(payload.intent).toBe('implementation');
    expect(payload.threadId).toBe(2);
  });

  it('classifies investigation intent from keywords (為什麼 CI 壞了？)', async () => {
    const gate = new IntentGate(bus, mockProvider);
    const handler = vi.fn();
    bus.on('intent.classified', handler);

    bus.emit('message.received', { message: makeMessage('為什麼 CI 壞了？'), threadId: 3 });

    await vi.waitFor(() => expect(handler).toHaveBeenCalled());

    const payload = handler.mock.calls[0][0];
    expect(payload.intent).toBe('investigation');
    expect(payload.threadId).toBe(3);
  });

  it('classifies quick-answer for short questions (API 怎麼用？)', async () => {
    const gate = new IntentGate(bus, mockProvider);
    const handler = vi.fn();
    bus.on('intent.classified', handler);

    bus.emit('message.received', { message: makeMessage('API 怎麼用？'), threadId: 4 });

    await vi.waitFor(() => expect(handler).toHaveBeenCalled());

    const payload = handler.mock.calls[0][0];
    expect(payload.intent).toBe('quick-answer');
    expect(payload.threadId).toBe(4);
  });

  it('classifies deliberation as default for longer ambiguous messages', async () => {
    const gate = new IntentGate(bus, mockProvider);
    const handler = vi.fn();
    bus.on('intent.classified', handler);

    const longAmbiguous =
      'I have been thinking about how we should approach our architecture going forward. There are many tradeoffs to consider and I am not sure which direction is best for the team at this stage.';
    bus.emit('message.received', { message: makeMessage(longAmbiguous), threadId: 5 });

    await vi.waitFor(() => expect(handler).toHaveBeenCalled());

    const payload = handler.mock.calls[0][0];
    expect(payload.intent).toBe('deliberation');
    expect(payload.threadId).toBe(5);
  });

  it('classifies low complexity for short simple messages', async () => {
    const gate = new IntentGate(bus, mockProvider);
    const handler = vi.fn();
    bus.on('intent.classified', handler);

    // Short question with ？triggers quick-answer at confidence 0.7 (keyword threshold met)
    bus.emit('message.received', { message: makeMessage('這是對的？'), threadId: 6 });

    await vi.waitFor(() => expect(handler).toHaveBeenCalled());

    const payload = handler.mock.calls[0][0];
    expect(payload.complexity).toBe('low');
    expect(payload.threadId).toBe(6);
  });

  it('falls back to LLM when keyword confidence is below threshold', async () => {
    const llmProvider = createMockProvider('{"intent": "investigation", "complexity": "high"}');
    const chatSpy = vi.spyOn(llmProvider, 'chat');
    const gate = new IntentGate(bus, llmProvider);
    const handler = vi.fn();
    bus.on('intent.classified', handler);

    // Long message with no clear keywords — low confidence → LLM fallback
    const ambiguous =
      'This situation has many layers and facets that need thorough consideration from all stakeholders involved in the process.';
    bus.emit('message.received', { message: makeMessage(ambiguous), threadId: 7 });

    await vi.waitFor(() => expect(handler).toHaveBeenCalled());

    expect(chatSpy).toHaveBeenCalled();
    const payload = handler.mock.calls[0][0];
    expect(payload.intent).toBe('investigation');
    expect(payload.complexity).toBe('high');
  });

  it('emits intent.classified with the original message attached', async () => {
    const gate = new IntentGate(bus, mockProvider);
    const handler = vi.fn();
    bus.on('intent.classified', handler);

    const msg = makeMessage('結束討論');
    bus.emit('message.received', { message: msg, threadId: 8 });

    await vi.waitFor(() => expect(handler).toHaveBeenCalled());

    const payload = handler.mock.calls[0][0];
    expect(payload.message).toEqual(msg);
  });

  it('handles LLM parse error gracefully by falling back to deliberation/medium', async () => {
    const badProvider = createMockProvider('not valid json at all');
    const gate = new IntentGate(bus, badProvider);
    const handler = vi.fn();
    bus.on('intent.classified', handler);

    // Use a message that will trigger LLM fallback (no keywords, long enough)
    const noKeyword =
      'Let us think together about what the right path forward might be considering all factors.';
    bus.emit('message.received', { message: makeMessage(noKeyword), threadId: 9 });

    await vi.waitFor(() => expect(handler).toHaveBeenCalled());

    const payload = handler.mock.calls[0][0];
    expect(payload.intent).toBe('deliberation');
    expect(payload.complexity).toBe('medium');
  });
});
