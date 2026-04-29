import { describe, it, expect, vi } from 'vitest';
import { OpenAIProvider } from '../../../src/worker/providers/openai.js';
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
    return {
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
  });
  return { chat: { completions: { create } } };
}

describe('OpenAIProvider abort', () => {
  it('Test C: no signal returns normally', async () => {
    const provider = new OpenAIProvider('fake-key');
    (provider as unknown as { client: unknown }).client = makeMockClient('success');
    const r = await provider.chat([{ role: 'user', content: 'hi' }], {
      model: 'gpt-5',
      systemPrompt: 'sys',
    });
    expect(r.content).toBe('ok');
  });

  it('Test A: pre-aborted signal throws abort', async () => {
    const provider = new OpenAIProvider('fake-key');
    (provider as unknown as { client: unknown }).client = makeMockClient('pre-aborted');
    const ctrl = new AbortController();
    ctrl.abort();
    let caught: unknown;
    try {
      await provider.chat([{ role: 'user', content: 'hi' }], {
        model: 'gpt-5', systemPrompt: 'sys', signal: ctrl.signal,
      });
    } catch (e) { caught = e; }
    expect(isAbortError(caught)).toBe(true);
  });

  it('Test B: mid-request signal abort', async () => {
    const provider = new OpenAIProvider('fake-key');
    (provider as unknown as { client: unknown }).client = makeMockClient('reject-on-signal');
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5);
    let caught: unknown;
    try {
      await provider.chat([{ role: 'user', content: 'hi' }], {
        model: 'gpt-5', systemPrompt: 'sys', signal: ctrl.signal,
      });
    } catch (e) { caught = e; }
    expect(isAbortError(caught)).toBe(true);
  });
});
