import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextHealthMonitor } from '../../src/gateway/context-health.js';
import type { CouncilMessage, LLMProvider } from '../../src/types.js';

const mockProvider: LLMProvider = {
  name: 'mock',
  chat: vi.fn().mockResolvedValue({ content: 'Summary of discussion so far.', tokensUsed: { input: 50, output: 30 } }),
  summarize: vi.fn().mockResolvedValue('Summary of discussion so far.'),
  estimateTokens: vi.fn().mockReturnValue(100),
};

describe('ContextHealthMonitor', () => {
  let monitor: ContextHealthMonitor;

  beforeEach(() => {
    monitor = new ContextHealthMonitor(10, mockProvider, 'claude-opus-4-7');
  });

  it('keeps recent messages within window', () => {
    for (let i = 0; i < 15; i++) {
      monitor.addMessage({
        id: `msg-${i}`,
        role: 'agent',
        agentId: 'huahua',
        content: `Message ${i}`,
        timestamp: Date.now() + i,
      });
    }
    const context = monitor.getContextMessages();
    expect(context.filter((m) => m.id.startsWith('msg-')).length).toBeLessThanOrEqual(10);
  });

  it('returns all messages when under window size', () => {
    for (let i = 0; i < 5; i++) {
      monitor.addMessage({
        id: `msg-${i}`,
        role: 'human',
        content: `Message ${i}`,
        timestamp: Date.now() + i,
      });
    }
    const context = monitor.getContextMessages();
    expect(context).toHaveLength(5);
  });

  it('compresses old messages when window is exceeded', async () => {
    for (let i = 0; i < 15; i++) {
      monitor.addMessage({
        id: `msg-${i}`,
        role: i % 2 === 0 ? 'human' : 'agent',
        agentId: i % 2 === 1 ? 'huahua' : undefined,
        content: `Message ${i} with some content to discuss.`,
        timestamp: Date.now() + i,
      });
    }

    await monitor.compress();
    const context = monitor.getContextMessages();
    expect(context[0].content).toContain('Summary');
    expect(context.length).toBeLessThanOrEqual(11);
  });
});
