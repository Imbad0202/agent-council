import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeProvider } from '../../../src/worker/providers/claude.js';
import type { ProviderMessage } from '../../../src/types.js';

const createSpy = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: createSpy };
    },
  };
});

describe('ClaudeProvider — extended thinking', () => {
  let provider: ClaudeProvider;

  beforeEach(() => {
    createSpy.mockReset();
    createSpy.mockResolvedValue({
      content: [
        { type: 'thinking', thinking: 'Let me weigh both sides before answering.' },
        { type: 'text', text: 'My considered answer is X.' },
      ],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    provider = new ClaudeProvider('test-api-key');
  });

  it('passes thinking param to SDK when provided', async () => {
    const messages: ProviderMessage[] = [{ role: 'user', content: 'Hard question.' }];
    await provider.chat(messages, {
      model: 'claude-opus-4-7',
      systemPrompt: 'You are thoughtful.',
      thinking: { type: 'enabled', budget_tokens: 32000 },
    });

    const callArgs = createSpy.mock.calls[0][0];
    expect(callArgs.thinking).toEqual({ type: 'enabled', budget_tokens: 32000 });
  });

  it('forces temperature=1 when thinking is enabled (SDK requires it)', async () => {
    const messages: ProviderMessage[] = [{ role: 'user', content: 'Hard question.' }];
    await provider.chat(messages, {
      model: 'claude-opus-4-7',
      systemPrompt: 'You are thoughtful.',
      temperature: 0.7,
      thinking: { type: 'enabled', budget_tokens: 32000 },
    });

    const callArgs = createSpy.mock.calls[0][0];
    expect(callArgs.temperature).toBe(1);
  });

  it('does not pass thinking when option omitted (regression safety)', async () => {
    const messages: ProviderMessage[] = [{ role: 'user', content: 'Normal question.' }];
    await provider.chat(messages, {
      model: 'claude-sonnet-4-6',
      systemPrompt: 'You are helpful.',
    });

    const callArgs = createSpy.mock.calls[0][0];
    expect(callArgs.thinking).toBeUndefined();
    expect(callArgs.temperature).toBe(0.7);
  });

  it('extracts thinking block into ProviderResponse.thinking', async () => {
    const messages: ProviderMessage[] = [{ role: 'user', content: 'Hard question.' }];
    const response = await provider.chat(messages, {
      model: 'claude-opus-4-7',
      systemPrompt: 'You are thoughtful.',
      thinking: { type: 'enabled', budget_tokens: 32000 },
    });

    expect(response.thinking).toBe('Let me weigh both sides before answering.');
    expect(response.content).toBe('My considered answer is X.');
  });

  it('omits thinking from response when SDK returns only text block', async () => {
    createSpy.mockResolvedValue({
      content: [{ type: 'text', text: 'Plain answer.' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const messages: ProviderMessage[] = [{ role: 'user', content: 'Q' }];
    const response = await provider.chat(messages, {
      model: 'claude-sonnet-4-6',
      systemPrompt: 'You are helpful.',
    });

    expect(response.thinking).toBeUndefined();
    expect(response.content).toBe('Plain answer.');
  });
});
