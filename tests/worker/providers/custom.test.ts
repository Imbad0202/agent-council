import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CustomProvider } from '../../../src/worker/providers/custom.js';
import type { ProviderMessage } from '../../../src/types.js';

describe('CustomProvider', () => {
  let provider: CustomProvider;

  beforeEach(() => {
    provider = new CustomProvider('http://localhost:11434/v1', 'test-key');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has name "custom"', () => {
    expect(provider.name).toBe('custom');
  });

  it('sends chat via fetch and returns ProviderResponse', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'response' } }],
        usage: { prompt_tokens: 80, completion_tokens: 40 },
      }),
    }));

    const messages: ProviderMessage[] = [
      { role: 'user', content: 'What do you think about X?' },
    ];
    const response = await provider.chat(messages, {
      model: 'llama3',
      systemPrompt: 'You are a critic.',
    });

    expect(response.content).toBe('response');
    expect(response.tokensUsed.input).toBe(80);
    expect(response.tokensUsed.output).toBe(40);

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:11434/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );

    vi.unstubAllGlobals();
  });

  it('estimates tokens roughly by character count', () => {
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'Hello, this is a test message with some words.' },
    ];
    const estimate = provider.estimateTokens(messages);
    expect(estimate).toBeGreaterThan(0);
    expect(typeof estimate).toBe('number');
  });

  it('includes Authorization header when apiKey provided', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    }));

    await provider.chat(
      [{ role: 'user', content: 'test' }],
      { model: 'llama3', systemPrompt: 'test' },
    );

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = fetchCall[1].headers;
    expect(headers['Authorization']).toBe('Bearer test-key');

    // Provider without apiKey should not include Authorization
    const noKeyProvider = new CustomProvider('http://localhost:11434/v1');
    await noKeyProvider.chat(
      [{ role: 'user', content: 'test' }],
      { model: 'llama3', systemPrompt: 'test' },
    );

    const fetchCall2 = (fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    const headers2 = fetchCall2[1].headers;
    expect(headers2['Authorization']).toBeUndefined();

    vi.unstubAllGlobals();
  });
});
