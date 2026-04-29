import { describe, it, expect, vi } from 'vitest';
import { ClaudeProvider } from '../../../src/worker/providers/claude.js';
import { isAbortError } from '../../../src/abort-utils.js';

function makeMockClient(behavior: 'success' | 'reject-on-signal' | 'pre-aborted') {
  const create = vi.fn(async (_body: unknown, options?: { signal?: AbortSignal }) => {
    if (behavior === 'pre-aborted' && options?.signal?.aborted) {
      const err = new Error('Request was aborted.');
      Object.defineProperty(err, 'constructor', { value: { name: 'APIUserAbortError' } });
      throw err;
    }
    if (behavior === 'reject-on-signal' && options?.signal) {
      return new Promise((_, reject) => {
        options.signal!.addEventListener('abort', () => {
          const err = new Error('Request was aborted.');
          Object.defineProperty(err, 'constructor', { value: { name: 'APIUserAbortError' } });
          reject(err);
        });
      });
    }
    return { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } };
  });
  return { messages: { create } };
}

describe('ClaudeProvider abort', () => {
  it('Test C: no signal returns normally (back-compat)', async () => {
    const provider = new ClaudeProvider('fake-key');
    (provider as unknown as { client: unknown }).client = makeMockClient('success');
    const r = await provider.chat([{ role: 'user', content: 'hi' }], {
      model: 'claude-sonnet-4-6',
      systemPrompt: 'sys',
    });
    expect(r.content).toBe('ok');
  });

  it('Test A: pre-aborted signal throws abort recognized by isAbortError', async () => {
    const provider = new ClaudeProvider('fake-key');
    (provider as unknown as { client: unknown }).client = makeMockClient('pre-aborted');
    const ctrl = new AbortController();
    ctrl.abort(new Error('user'));
    let caught: unknown;
    try {
      await provider.chat([{ role: 'user', content: 'hi' }], {
        model: 'claude-sonnet-4-6',
        systemPrompt: 'sys',
        signal: ctrl.signal,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(isAbortError(caught)).toBe(true);
  });

  it('Test B: signal that fires mid-request throws abort', async () => {
    const provider = new ClaudeProvider('fake-key');
    (provider as unknown as { client: unknown }).client = makeMockClient('reject-on-signal');
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new Error('user')), 5);
    let caught: unknown;
    try {
      await provider.chat([{ role: 'user', content: 'hi' }], {
        model: 'claude-sonnet-4-6',
        systemPrompt: 'sys',
        signal: ctrl.signal,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(isAbortError(caught)).toBe(true);
  });
});
