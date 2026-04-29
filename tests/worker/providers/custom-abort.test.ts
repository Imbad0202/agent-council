import { describe, it, expect, vi, afterEach } from 'vitest';
import { CustomProvider } from '../../../src/worker/providers/custom.js';
import { isAbortError } from '../../../src/abort-utils.js';

// CustomProvider constructor: (baseUrl: string, apiKey?: string)
// Positional args — not an object shape.

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

describe('CustomProvider abort', () => {
  it('Test C: no signal — fetch still gets internal 60s signal (back-compat)', async () => {
    let captured: { signal?: AbortSignal } | undefined;
    global.fetch = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
      captured = init;
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new CustomProvider('http://example.com', 'k');
    await provider.chat([{ role: 'user', content: 'hi' }], { model: 'm', systemPrompt: 's' });
    expect(captured?.signal).toBeDefined();
  });

  it('Test A: pre-aborted external signal aborts fetch', async () => {
    global.fetch = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
      if (init?.signal?.aborted) {
        throw new DOMException('aborted', 'AbortError');
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new CustomProvider('http://example.com', 'k');
    const ctrl = new AbortController();
    ctrl.abort();
    let caught: unknown;
    try {
      await provider.chat([{ role: 'user', content: 'hi' }], { model: 'm', systemPrompt: 's', signal: ctrl.signal });
    } catch (e) { caught = e; }
    expect(isAbortError(caught)).toBe(true);
  });

  it('signal merge — external signal aborts merged signal mid-flight', async () => {
    global.fetch = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')));
      });
    }) as unknown as typeof fetch;
    const provider = new CustomProvider('http://example.com', 'k');
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5);
    let caught: unknown;
    try {
      await provider.chat([{ role: 'user', content: 'hi' }], { model: 'm', systemPrompt: 's', signal: ctrl.signal });
    } catch (e) { caught = e; }
    expect(isAbortError(caught)).toBe(true);
  });
});
