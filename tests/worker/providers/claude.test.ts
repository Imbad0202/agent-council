import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeProvider } from '../../../src/worker/providers/claude.js';
import type { ProviderMessage } from '../../../src/types.js';

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'I disagree because the approach has three flaws...' }],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      };
    },
  };
});

describe('ClaudeProvider', () => {
  let provider: ClaudeProvider;

  beforeEach(() => {
    provider = new ClaudeProvider('test-api-key');
  });

  it('has name "claude"', () => {
    expect(provider.name).toBe('claude');
  });

  it('sends chat messages and returns ProviderResponse', async () => {
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'What do you think about X?' },
    ];
    const response = await provider.chat(messages, {
      model: 'claude-opus-4-6',
      systemPrompt: 'You are a critic.',
    });

    expect(response.content).toContain('disagree');
    expect(response.tokensUsed.input).toBe(100);
    expect(response.tokensUsed.output).toBe(50);
    expect(response.skip).toBeUndefined();
  });

  it('estimates tokens roughly by character count', () => {
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'Hello, this is a test message with some words.' },
    ];
    const estimate = provider.estimateTokens(messages);
    expect(estimate).toBeGreaterThan(0);
    expect(typeof estimate).toBe('number');
  });

  it('summarizes text', async () => {
    const summary = await provider.summarize('A long discussion about monorepos...', 'claude-opus-4-6');
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
  });
});
