import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryConsolidator } from '../../src/memory/consolidator.js';
import { MemoryDB } from '../../src/memory/db.js';
import { rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MemoryRecord, LLMProvider, ProviderMessage, ChatOptions, ProviderResponse } from '../../src/types.js';

const mockLLM: LLMProvider = {
  name: 'mock',
  async chat(_messages: ProviderMessage[], _options: ChatOptions): Promise<ProviderResponse> {
    return {
      content: JSON.stringify({
        principle: 'Our architecture principle: favor simplicity.',
        pattern: 'tends toward conservative positions on architecture',
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

describe('MemoryConsolidator', () => {
  const testDir = join(tmpdir(), 'agent-council-consolidator-test');
  const testDbPath = join(testDir, 'brain.db');
  const dataDir = join(testDir, 'data');
  let db: MemoryDB;
  let consolidator: MemoryConsolidator;

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(join(dataDir, 'huahua', 'sessions'), { recursive: true });
    mkdirSync(join(dataDir, 'huahua', 'principles'), { recursive: true });
    mkdirSync(join(dataDir, 'huahua', 'archive'), { recursive: true });

    db = new MemoryDB(testDbPath);
    consolidator = new MemoryConsolidator(db, dataDir, mockLLM, 'mock-model');

    // Insert 5 session memories with topic 'architecture'
    for (let i = 0; i < 5; i++) {
      const id = `huahua/sessions/session-arch-${i}.md`;
      const record: MemoryRecord = {
        id,
        agentId: 'huahua',
        type: 'session',
        topic: 'architecture',
        confidence: 0.7,
        outcome: 'decision',
        usageCount: i + 1,
        lastUsed: '2026-04-10',
        createdAt: '2026-04-01',
        contentPreview: `Architecture discussion ${i}`,
      };
      db.insertMemory(record);
      writeFileSync(
        join(dataDir, id),
        `# Architecture Session ${i}\nWe discussed architecture patterns and decided on approach ${i}.`,
      );
    }
  });

  afterEach(() => {
    db.close();
  });

  it('getConsolidatableTopics returns topics exceeding threshold', () => {
    const topics = consolidator.getConsolidatableTopics('huahua', 3);
    expect(topics).toEqual(['architecture']);

    const empty = consolidator.getConsolidatableTopics('huahua', 10);
    expect(empty).toEqual([]);
  });

  it('consolidate creates principle, archives sessions, and inserts pattern', async () => {
    await consolidator.consolidate('huahua', 'architecture');

    // Principle file exists
    const principlePath = join(dataDir, 'huahua', 'principles', 'principle-architecture.md');
    expect(existsSync(principlePath)).toBe(true);

    const content = readFileSync(principlePath, 'utf-8');
    expect(content).toContain('Our architecture principle: favor simplicity.');

    // Original sessions archived in DB
    for (let i = 0; i < 5; i++) {
      const record = db.getMemory(`huahua/sessions/session-arch-${i}.md`);
      expect(record!.type).toBe('archive');
    }

    // Session files moved to archive/
    for (let i = 0; i < 5; i++) {
      const archivePath = join(dataDir, 'huahua', 'archive', `session-arch-${i}.md`);
      expect(existsSync(archivePath)).toBe(true);
      const sessionPath = join(dataDir, 'huahua', 'sessions', `session-arch-${i}.md`);
      expect(existsSync(sessionPath)).toBe(false);
    }

    // Principle record inserted in DB
    const principles = db.listMemories('huahua', 'principle');
    expect(principles.length).toBeGreaterThanOrEqual(1);
    const principleRecord = principles.find((p) => p.topic === 'architecture');
    expect(principleRecord).toBeDefined();
    expect(principleRecord!.type).toBe('principle');

    // Pattern inserted in patterns table
    const patterns = db.getPatterns('huahua', 'architecture');
    expect(patterns.length).toBeGreaterThanOrEqual(1);
    expect(patterns[0].behavior).toBe('tends toward conservative positions on architecture');
  });

  it('consolidate is idempotent — no sessions left to consolidate after first run', async () => {
    await consolidator.consolidate('huahua', 'architecture');

    // After consolidation, no session-type memories remain for this topic
    const remaining = db.getMemoriesByTopic('huahua', 'architecture', 'session');
    expect(remaining).toHaveLength(0);

    // So the topic should no longer be consolidatable
    const topics = consolidator.getConsolidatableTopics('huahua', 3);
    expect(topics).toEqual([]);
  });
});
