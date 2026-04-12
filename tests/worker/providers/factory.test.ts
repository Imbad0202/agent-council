import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createProvider } from '../../../src/worker/providers/factory.js';

vi.mock('../../../src/worker/providers/claude.js', () => ({
  ClaudeProvider: class { name = 'claude'; },
}));
vi.mock('../../../src/worker/providers/openai.js', () => ({
  OpenAIProvider: class { name = 'openai'; },
}));
vi.mock('../../../src/worker/providers/google.js', () => ({
  GoogleProvider: class { name = 'google'; },
}));
vi.mock('../../../src/worker/providers/custom.js', () => ({
  CustomProvider: class { name = 'custom'; },
}));

describe('createProvider', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...savedEnv };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('creates ClaudeProvider for "claude"', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const provider = createProvider('claude');
    expect(provider.name).toBe('claude');
  });

  it('throws for unknown provider', () => {
    expect(() => createProvider('grok')).toThrow('Unknown provider: grok');
  });

  it('throws when required env var missing', () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => createProvider('claude')).toThrow('ANTHROPIC_API_KEY required');

    delete process.env.OPENAI_API_KEY;
    expect(() => createProvider('openai')).toThrow('OPENAI_API_KEY required');

    delete process.env.GOOGLE_AI_API_KEY;
    expect(() => createProvider('google')).toThrow('GOOGLE_AI_API_KEY required');

    delete process.env.CUSTOM_PROVIDER_URL;
    expect(() => createProvider('custom')).toThrow('CUSTOM_PROVIDER_URL required');
  });
});
