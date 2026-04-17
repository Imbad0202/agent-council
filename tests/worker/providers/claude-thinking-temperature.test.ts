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

describe('ClaudeProvider — thinking/temperature contract', () => {
  let provider: ClaudeProvider;

  beforeEach(() => {
    createSpy.mockReset();
    createSpy.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    provider = new ClaudeProvider('test-key');
  });

  it('throws when caller supplies thinking and an explicit non-1 temperature', async () => {
    const messages: ProviderMessage[] = [{ role: 'user', content: 'Q' }];
    await expect(
      provider.chat(messages, {
        model: 'claude-opus-4-7',
        systemPrompt: 'sys',
        temperature: 0.7,
        thinking: { type: 'enabled', budget_tokens: 32000 },
      }),
    ).rejects.toThrow(/temperature.*1.*thinking/i);
  });

  it('accepts thinking with temperature=1 (explicit match)', async () => {
    const messages: ProviderMessage[] = [{ role: 'user', content: 'Q' }];
    await provider.chat(messages, {
      model: 'claude-opus-4-7',
      systemPrompt: 'sys',
      temperature: 1,
      thinking: { type: 'enabled', budget_tokens: 32000 },
    });
    expect(createSpy).toHaveBeenCalledOnce();
  });

  it('accepts thinking with temperature omitted (defaults to 1)', async () => {
    const messages: ProviderMessage[] = [{ role: 'user', content: 'Q' }];
    await provider.chat(messages, {
      model: 'claude-opus-4-7',
      systemPrompt: 'sys',
      thinking: { type: 'enabled', budget_tokens: 32000 },
    });
    const callArgs = createSpy.mock.calls[0][0];
    expect(callArgs.temperature).toBe(1);
  });
});
