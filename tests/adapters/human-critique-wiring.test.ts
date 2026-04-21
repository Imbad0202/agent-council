import { describe, it, expect, vi } from 'vitest';
import { CliAdapter } from '../../src/adapters/cli.js';
import { TelegramAdapter } from '../../src/adapters/telegram.js';
import type { HumanCritiqueWiring } from '../../src/council/human-critique-wiring.js';
import type { HumanCritiqueStore } from '../../src/council/human-critique-store.js';

describe('HumanCritiqueWiring — adapter duck-typing', () => {
  it('CliAdapter exposes setHumanCritiqueWiring and accepts a wiring object', () => {
    const adapter = new CliAdapter({ verbose: false });
    expect(typeof adapter.setHumanCritiqueWiring).toBe('function');

    const mockStore = {
      submit: vi.fn(),
      skip: vi.fn(),
    } as unknown as HumanCritiqueStore;

    const wiring: HumanCritiqueWiring = {
      store: mockStore,
      promptUser: vi.fn().mockResolvedValue({ kind: 'skipped' }),
    };
    expect(() => adapter.setHumanCritiqueWiring!(wiring)).not.toThrow();
  });

  it('TelegramAdapter exposes setHumanCritiqueWiring and accepts a wiring object', () => {
    const adapter = new TelegramAdapter({
      groupChatId: 1,
      agents: [{
        id: 'a',
        name: 'A',
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        memoryDir: 'a/',
        personality: 'test',
      }],
      listenerAgentId: 'a',
    });
    expect(typeof adapter.setHumanCritiqueWiring).toBe('function');

    const mockStore = {
      submit: vi.fn(),
      skip: vi.fn(),
    } as unknown as HumanCritiqueStore;

    const wiring: HumanCritiqueWiring = {
      store: mockStore,
      promptUser: vi.fn().mockResolvedValue({ kind: 'skipped' }),
    };
    expect(() => adapter.setHumanCritiqueWiring!(wiring)).not.toThrow();
  });

  it('CLI critique hook prompts user via readline when human-critique.requested fires', async () => {
    const submit = vi.fn();
    const skip = vi.fn();
    const mockStore = { submit, skip } as unknown as HumanCritiqueStore;

    const adapter = new CliAdapter({ verbose: false });
    const promptUser = vi.fn().mockResolvedValue({
      kind: 'submitted',
      stance: 'challenge',
      content: 'ignored cost',
    });
    adapter.setHumanCritiqueWiring!({ store: mockStore, promptUser });

    // Simulate the handler invoking the wiring when the bus requests critique
    await adapter.handleCritiqueRequest!({
      threadId: 1,
      prevAgent: 'huahua',
      nextAgent: 'binbin',
    });

    expect(promptUser).toHaveBeenCalledWith({
      threadId: 1,
      prevAgent: 'huahua',
      nextAgent: 'binbin',
    });
    expect(submit).toHaveBeenCalledWith(1, {
      stance: 'challenge',
      content: 'ignored cost',
    });
    expect(skip).not.toHaveBeenCalled();
  });

  it('CLI critique hook calls store.skip when promptUser returns skipped', async () => {
    const submit = vi.fn();
    const skip = vi.fn();
    const mockStore = { submit, skip } as unknown as HumanCritiqueStore;

    const adapter = new CliAdapter({ verbose: false });
    const promptUser = vi.fn().mockResolvedValue({ kind: 'skipped' });
    adapter.setHumanCritiqueWiring!({ store: mockStore, promptUser });

    await adapter.handleCritiqueRequest!({ threadId: 5, prevAgent: 'a', nextAgent: 'b' });

    expect(skip).toHaveBeenCalledWith(5, 'user-skip');
    expect(submit).not.toHaveBeenCalled();
  });

  it('without wiring, handleCritiqueRequest is a no-op (does not throw)', async () => {
    const adapter = new CliAdapter({ verbose: false });
    await expect(
      adapter.handleCritiqueRequest!({ threadId: 1, prevAgent: 'a', nextAgent: 'b' }),
    ).resolves.toBeUndefined();
  });

  it('if promptUser throws, wiring falls through to store.skip("user-skip")', async () => {
    const submit = vi.fn();
    const skip = vi.fn();
    const mockStore = { submit, skip } as unknown as HumanCritiqueStore;

    const adapter = new CliAdapter({ verbose: false });
    const promptUser = vi.fn().mockRejectedValue(new Error('readline closed'));
    adapter.setHumanCritiqueWiring!({ store: mockStore, promptUser });

    await expect(
      adapter.handleCritiqueRequest!({ threadId: 7, prevAgent: 'a', nextAgent: 'b' }),
    ).resolves.toBeUndefined();

    expect(skip).toHaveBeenCalledWith(7, 'user-skip');
    expect(submit).not.toHaveBeenCalled();
  });
});
