import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleProvider } from '../../../src/worker/providers/google.js';
import type { ProviderMessage } from '../../../src/types.js';

vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class MockGoogleGenAI {
      models = {
        generateContent: vi.fn().mockResolvedValue({
          text: 'From a data-driven perspective, the evidence suggests...',
          usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 45 },
        }),
      };
    },
  };
});

describe('GoogleProvider', () => {
  let provider: GoogleProvider;

  beforeEach(() => {
    provider = new GoogleProvider('test-api-key');
  });

  it('has name "google"', () => {
    expect(provider.name).toBe('google');
  });

  it('sends chat messages and returns ProviderResponse', async () => {
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'Analyze this data.' },
    ];
    const response = await provider.chat(messages, {
      model: 'gemini-2.5-pro',
      systemPrompt: 'You are an analyst.',
    });
    expect(response.content).toContain('data-driven');
    expect(response.tokensUsed.input).toBe(120);
    expect(response.tokensUsed.output).toBe(45);
  });

  it('estimates tokens by character count', () => {
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'Hello, this is a test message.' },
    ];
    const estimate = provider.estimateTokens(messages);
    expect(estimate).toBeGreaterThan(0);
  });

  it('summarizes text', async () => {
    const summary = await provider.summarize('Long discussion...', 'gemini-2.5-pro');
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
  });
});
