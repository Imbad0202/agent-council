import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIProvider } from '../../../src/worker/providers/openai.js';
import type { ProviderMessage } from '../../../src/types.js';

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: 'I have a different perspective on this...' } }],
            usage: { prompt_tokens: 150, completion_tokens: 60 },
          }),
        },
      };
    },
  };
});

describe('OpenAIProvider', () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    provider = new OpenAIProvider('test-api-key');
  });

  it('has name "openai"', () => {
    expect(provider.name).toBe('openai');
  });

  it('sends chat messages and returns ProviderResponse', async () => {
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'What do you think about X?' },
    ];
    const response = await provider.chat(messages, {
      model: 'gpt-4o',
      systemPrompt: 'You are a critic.',
    });

    expect(response.content).toContain('different perspective');
    expect(response.tokensUsed.input).toBe(150);
    expect(response.tokensUsed.output).toBe(60);
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
    const summary = await provider.summarize('A long discussion about monorepos...', 'gpt-4o');
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
  });
});
