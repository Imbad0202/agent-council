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

describe('ClaudeProvider — prompt caching', () => {
  let provider: ClaudeProvider;

  beforeEach(() => {
    createSpy.mockReset();
    createSpy.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    provider = new ClaudeProvider('test-key');
  });

  it('uses systemPromptParts with cache_control when provided', async () => {
    const messages: ProviderMessage[] = [{ role: 'user', content: 'Q' }];
    await provider.chat(messages, {
      model: 'claude-opus-4-7',
      systemPrompt: 'FALLBACK',
      systemPromptParts: [
        { text: 'STABLE PREFIX', cache: true },
        { text: 'VOLATILE SUFFIX' },
      ],
    });

    const callArgs = createSpy.mock.calls[0][0];
    expect(Array.isArray(callArgs.system)).toBe(true);
    expect(callArgs.system[0]).toEqual({
      type: 'text',
      text: 'STABLE PREFIX',
      cache_control: { type: 'ephemeral' },
    });
    expect(callArgs.system[1]).toEqual({ type: 'text', text: 'VOLATILE SUFFIX' });
    expect(callArgs.system[1].cache_control).toBeUndefined();
  });

  it('uses systemPrompt string when systemPromptParts is absent', async () => {
    const messages: ProviderMessage[] = [{ role: 'user', content: 'Q' }];
    await provider.chat(messages, {
      model: 'claude-sonnet-4-6',
      systemPrompt: 'Just a plain string.',
    });

    const callArgs = createSpy.mock.calls[0][0];
    expect(callArgs.system).toBe('Just a plain string.');
  });

  it('emits multi-part system without cache_control when no parts have cache flag', async () => {
    const messages: ProviderMessage[] = [{ role: 'user', content: 'Q' }];
    await provider.chat(messages, {
      model: 'claude-sonnet-4-6',
      systemPrompt: 'fallback',
      systemPromptParts: [{ text: 'A' }, { text: 'B' }],
    });

    const callArgs = createSpy.mock.calls[0][0];
    expect(callArgs.system).toEqual([
      { type: 'text', text: 'A' },
      { type: 'text', text: 'B' },
    ]);
  });
});
