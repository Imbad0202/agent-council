import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateSessionSummary, saveSessionSummary } from '../../src/memory/session-summary.js';
import type { CouncilMessage, LLMProvider } from '../../src/types.js';
import { readFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mockProvider: LLMProvider = {
  name: 'mock',
  chat: vi.fn().mockResolvedValue({
    content: 'Decided to use monorepo. Key reasons: simplicity and shared tooling.',
    tokensUsed: { input: 200, output: 80 },
  }),
  summarize: vi.fn().mockResolvedValue('Decided to use monorepo. Key reasons: simplicity and shared tooling.'),
  estimateTokens: vi.fn().mockReturnValue(100),
};

describe('session-summary', () => {
  const testDir = join(tmpdir(), 'agent-council-test-summary');

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(join(testDir, 'huahua', 'sessions'), { recursive: true });
    mkdirSync(join(testDir, 'binbin', 'sessions'), { recursive: true });
  });

  const messages: CouncilMessage[] = [
    { id: '1', role: 'human', content: 'Should we use monorepo or polyrepo?', timestamp: 1000 },
    { id: '2', role: 'agent', agentId: 'huahua', content: 'Monorepo is better for us.', timestamp: 2000 },
    { id: '3', role: 'agent', agentId: 'binbin', content: 'I disagree, polyrepo gives more flexibility.', timestamp: 3000 },
    { id: '4', role: 'human', content: 'Go with monorepo.', timestamp: 4000 },
  ];

  it('generates a summary from conversation', async () => {
    const summary = await generateSessionSummary(messages, ['huahua', 'binbin'], mockProvider, 'claude-opus-4-6');
    expect(summary).toContain('monorepo');
  });

  it('saves summary files for each agent', () => {
    const summaryContent = 'Decided to use monorepo.';
    saveSessionSummary(testDir, ['huahua', 'binbin'], summaryContent, 'monorepo-vs-polyrepo');

    const huahuaFiles = readdirSync(join(testDir, 'huahua', 'sessions'));
    const binbinFiles = readdirSync(join(testDir, 'binbin', 'sessions'));

    expect(huahuaFiles.length).toBe(1);
    expect(binbinFiles.length).toBe(1);
    expect(huahuaFiles[0]).toContain('monorepo-vs-polyrepo');

    const content = readFileSync(join(testDir, 'huahua', 'sessions', huahuaFiles[0]), 'utf-8');
    expect(content).toContain('council-session');
    expect(content).toContain('Decided to use monorepo');
  });
});
