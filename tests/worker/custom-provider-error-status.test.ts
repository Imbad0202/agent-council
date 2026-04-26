import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CustomProvider } from '../../src/worker/providers/custom.js';

describe('CustomProvider error.status', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('attaches .status when upstream returns non-OK', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 503, text: async () => 'service unavailable',
    } as Response);

    const provider = new CustomProvider('http://example.invalid', 'key');
    let caught: unknown;
    try {
      await provider.chat([{ role: 'user', content: 'x' }], { model: 'm', systemPrompt: '' });
    } catch (err) { caught = err; }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error & { status?: number }).status).toBe(503);
  });
});
