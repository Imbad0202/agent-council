import { describe, it, expect, vi } from 'vitest';
import { GoogleProvider } from '../../../src/worker/providers/google.js';
import { isAbortError } from '../../../src/abort-utils.js';

function makeMockClient(behavior: 'success' | 'reject-on-signal' | 'pre-aborted') {
  const generateContent = vi.fn(async (params: { config?: { abortSignal?: AbortSignal } }) => {
    const sig = params.config?.abortSignal;
    if (behavior === 'pre-aborted' && sig?.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }
    if (behavior === 'reject-on-signal' && sig) {
      return new Promise((_, reject) => {
        sig.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    return { text: 'ok', usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
  });
  return { models: { generateContent } };
}

describe('GoogleProvider abort', () => {
  it('Test C: no signal returns normally', async () => {
    const provider = new GoogleProvider('fake-key');
    (provider as unknown as { client: unknown }).client = makeMockClient('success');
    const r = await provider.chat([{ role: 'user', content: 'hi' }], {
      model: 'gemini-2.5-pro', systemPrompt: 'sys',
    });
    expect(r.content).toBe('ok');
  });

  it('Test A: pre-aborted signal throws abort', async () => {
    const provider = new GoogleProvider('fake-key');
    (provider as unknown as { client: unknown }).client = makeMockClient('pre-aborted');
    const ctrl = new AbortController();
    ctrl.abort();
    let caught: unknown;
    try {
      await provider.chat([{ role: 'user', content: 'hi' }], {
        model: 'gemini-2.5-pro', systemPrompt: 'sys', signal: ctrl.signal,
      });
    } catch (e) { caught = e; }
    expect(isAbortError(caught)).toBe(true);
  });

  it('Test B: mid-request signal abort', async () => {
    const provider = new GoogleProvider('fake-key');
    (provider as unknown as { client: unknown }).client = makeMockClient('reject-on-signal');
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5);
    let caught: unknown;
    try {
      await provider.chat([{ role: 'user', content: 'hi' }], {
        model: 'gemini-2.5-pro', systemPrompt: 'sys', signal: ctrl.signal,
      });
    } catch (e) { caught = e; }
    expect(isAbortError(caught)).toBe(true);
  });
});
