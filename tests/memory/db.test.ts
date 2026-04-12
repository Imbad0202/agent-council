import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryDB } from '../../src/memory/db.js';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MemoryRecord } from '../../src/types.js';

describe('MemoryDB', () => {
  const testDbPath = join(tmpdir(), 'agent-council-test-db', 'test.db');
  let db: MemoryDB;

  beforeEach(() => {
    rmSync(join(tmpdir(), 'agent-council-test-db'), { recursive: true, force: true });
    db = new MemoryDB(testDbPath);
  });

  afterEach(() => {
    db.close();
  });

  it('creates tables on init', () => {
    const tables = db.listTables();
    expect(tables).toContain('memories');
    expect(tables).toContain('patterns');
    expect(tables).toContain('memories_fts');
  });

  it('inserts and retrieves a memory record', () => {
    const record: MemoryRecord = {
      id: 'mem-001',
      agentId: 'huahua',
      type: 'session',
      topic: 'monorepo decision',
      confidence: 0.85,
      outcome: 'decision',
      usageCount: 3,
      lastUsed: '2026-04-10',
      createdAt: '2026-04-01',
      contentPreview: 'Decided to use monorepo for simplicity.',
    };

    db.insertMemory(record);
    const retrieved = db.getMemory('mem-001');

    expect(retrieved).not.toBeNull();
    expect(retrieved!.agentId).toBe('huahua');
    expect(retrieved!.type).toBe('session');
    expect(retrieved!.topic).toBe('monorepo decision');
    expect(retrieved!.confidence).toBe(0.85);
    expect(retrieved!.outcome).toBe('decision');
    expect(retrieved!.usageCount).toBe(3);
    expect(retrieved!.lastUsed).toBe('2026-04-10');
    expect(retrieved!.contentPreview).toBe('Decided to use monorepo for simplicity.');
  });

  it('searches memories via FTS5', () => {
    db.insertMemory({
      id: 'mem-search-1',
      agentId: 'huahua',
      type: 'session',
      topic: 'monorepo architecture',
      confidence: 0.8,
      outcome: 'decision',
      usageCount: 5,
      lastUsed: '2026-04-10',
      createdAt: '2026-04-01',
      contentPreview: 'Monorepo with turborepo for build orchestration.',
    });

    db.insertMemory({
      id: 'mem-search-2',
      agentId: 'huahua',
      type: 'session',
      topic: 'testing strategy',
      confidence: 0.7,
      outcome: 'open',
      usageCount: 1,
      lastUsed: '2026-04-08',
      createdAt: '2026-04-02',
      contentPreview: 'Unit tests with vitest, integration tests pending.',
    });

    const results = db.searchMemories('monorepo');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe('mem-search-1');
  });

  it('increments usage count', () => {
    db.insertMemory({
      id: 'mem-usage',
      agentId: 'huahua',
      type: 'session',
      topic: 'testing',
      confidence: 0.7,
      outcome: null,
      usageCount: 0,
      lastUsed: null,
      createdAt: '2026-04-01',
      contentPreview: 'Testing approach discussion.',
    });

    db.incrementUsage('mem-usage', '2026-04-12');

    const record = db.getMemory('mem-usage');
    expect(record!.usageCount).toBe(1);
    expect(record!.lastUsed).toBe('2026-04-12');
  });

  it('updates memory type for archiving', () => {
    db.insertMemory({
      id: 'mem-archive',
      agentId: 'huahua',
      type: 'session',
      topic: 'old topic',
      confidence: 0.5,
      outcome: 'deferred',
      usageCount: 0,
      lastUsed: null,
      createdAt: '2026-01-01',
      contentPreview: 'Stale discussion.',
    });

    db.updateType('mem-archive', 'archive');

    const record = db.getMemory('mem-archive');
    expect(record!.type).toBe('archive');
  });

  it('lists memories by agent and type', () => {
    const base = {
      confidence: 0.7,
      outcome: null as null,
      lastUsed: '2026-04-10',
      createdAt: '2026-04-01',
    };

    db.insertMemory({ ...base, id: 'a1', agentId: 'huahua', type: 'session', topic: 't1', usageCount: 2, contentPreview: 'Session 1' });
    db.insertMemory({ ...base, id: 'a2', agentId: 'huahua', type: 'principle', topic: 't2', usageCount: 5, contentPreview: 'Principle 1' });
    db.insertMemory({ ...base, id: 'a3', agentId: 'huahua', type: 'archive', topic: 't3', usageCount: 0, contentPreview: 'Archived' });
    db.insertMemory({ ...base, id: 'b1', agentId: 'binbin', type: 'session', topic: 't4', usageCount: 1, contentPreview: 'Other agent' });

    // Without type filter — excludes archive
    const allActive = db.listMemories('huahua');
    expect(allActive).toHaveLength(2);
    expect(allActive[0].id).toBe('a2'); // higher usage_count first
    expect(allActive[1].id).toBe('a1');

    // With type filter
    const principles = db.listMemories('huahua', 'principle');
    expect(principles).toHaveLength(1);
    expect(principles[0].id).toBe('a2');

    // Archive explicitly requested
    const archived = db.listMemories('huahua', 'archive');
    expect(archived).toHaveLength(1);
    expect(archived[0].id).toBe('a3');
  });

  it('inserts and retrieves patterns', () => {
    db.insertPattern({
      agentId: 'huahua',
      topic: 'code review',
      behavior: 'Always agrees with senior dev suggestions',
      extractedFrom: 'mem-001',
    });

    db.insertPattern({
      agentId: 'huahua',
      topic: 'architecture',
      behavior: 'Defers to authority without analysis',
      extractedFrom: 'mem-002',
    });

    const allPatterns = db.getPatterns('huahua');
    expect(allPatterns).toHaveLength(2);
    expect(allPatterns[0].behavior).toContain('agrees');

    const filtered = db.getPatterns('huahua', 'architecture');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].behavior).toContain('authority');
  });

  it('counts active memories per agent excluding archive', () => {
    const base = {
      confidence: 0.7,
      outcome: null as null,
      usageCount: 1,
      lastUsed: '2026-04-10',
      createdAt: '2026-04-01',
    };

    db.insertMemory({ ...base, id: 'c1', agentId: 'huahua', type: 'session', topic: 't1', contentPreview: 'S1' });
    db.insertMemory({ ...base, id: 'c2', agentId: 'huahua', type: 'principle', topic: 't2', contentPreview: 'P1' });
    db.insertMemory({ ...base, id: 'c3', agentId: 'huahua', type: 'archive', topic: 't3', contentPreview: 'A1' });
    db.insertMemory({ ...base, id: 'c4', agentId: 'binbin', type: 'session', topic: 't4', contentPreview: 'S2' });

    expect(db.countActiveMemories('huahua')).toBe(2);
    expect(db.countActiveMemories('binbin')).toBe(1);
  });
});
