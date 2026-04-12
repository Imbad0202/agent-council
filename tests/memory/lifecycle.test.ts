import { describe, it, expect, vi } from 'vitest';
import { SessionLifecycle } from '../../src/memory/lifecycle.js';
import type { LLMProvider, MemoryConfig, ProviderMessage, ChatOptions, ProviderResponse } from '../../src/types.js';

const mockProvider: LLMProvider = {
  name: 'mock',
  async chat(_messages: ProviderMessage[], _options: ChatOptions): Promise<ProviderResponse> {
    return {
      content: JSON.stringify({
        topic: 'architecture',
        outcome: 'decision',
        confidence: 0.8,
      }),
      tokensUsed: { input: 100, output: 50 },
    };
  },
  async summarize(_text: string, _model: string): Promise<string> {
    return 'summary';
  },
  estimateTokens(_messages: ProviderMessage[]): number {
    return 100;
  },
};

const memoryConfig: MemoryConfig = {
  dbPath: ':memory:',
  sessionTimeoutMs: 300000,
  endKeywords: ['結束', 'done', '結論'],
  archiveThreshold: 30,
  archiveBottomPercent: 20,
  consolidationThreshold: 5,
};

describe('SessionLifecycle', () => {
  const lifecycle = new SessionLifecycle(memoryConfig, mockProvider, 'mock-model');

  it('isEndKeyword detects end keywords', () => {
    expect(lifecycle.isEndKeyword('結束')).toBe(true);
    expect(lifecycle.isEndKeyword('我們 done 了')).toBe(true);
    expect(lifecycle.isEndKeyword('結論是...')).toBe(true);
  });

  it('isEndKeyword does not trigger on normal messages', () => {
    expect(lifecycle.isEndKeyword('What do you think?')).toBe(false);
    expect(lifecycle.isEndKeyword('繼續討論')).toBe(false);
  });

  it('extractTopicAndOutcome extracts topic and outcome from conversation', async () => {
    const messages = [
      { id: '1', role: 'human' as const, content: 'Should we use monorepo?', timestamp: 1000 },
      { id: '2', role: 'agent' as const, agentId: 'huahua', content: 'Yes, monorepo is better.', timestamp: 2000 },
      { id: '3', role: 'agent' as const, agentId: 'binbin', content: 'Agreed, monorepo wins.', timestamp: 3000 },
    ];

    const result = await lifecycle.extractTopicAndOutcome(messages);
    expect(result.topic).toBe('architecture');
    expect(result.outcome).toBe('decision');
    expect(result.confidence).toBe(0.8);
  });
});
