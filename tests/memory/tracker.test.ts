import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UsageTracker } from '../../src/memory/tracker.js';
import { MemoryDB } from '../../src/memory/db.js';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MemoryRecord } from '../../src/types.js';

describe('UsageTracker', () => {
  const testDbDir = join(tmpdir(), 'agent-council-tracker-test');
  const testDbPath = join(testDbDir, 'test.db');
  let db: MemoryDB;
  let tracker: UsageTracker;

  beforeEach(() => {
    rmSync(testDbDir, { recursive: true, force: true });
    db = new MemoryDB(testDbPath);
    tracker = new UsageTracker(db);
  });

  afterEach(() => {
    db.close();
  });

  it('extracts references from response content', () => {
    const content = 'Based on [ref:principle-architecture.md], also [ref:session-monorepo.md].';
    const refs = tracker.extractReferences(content);
    expect(refs).toEqual(['principle-architecture.md', 'session-monorepo.md']);
  });

  it('returns empty array when no references', () => {
    const refs = tracker.extractReferences('No references here at all.');
    expect(refs).toEqual([]);
  });

  it('updates usage count for known references', () => {
    const record: MemoryRecord = {
      id: 'known.md',
      agentId: 'huahua',
      type: 'principle',
      topic: 'architecture',
      confidence: 0.9,
      outcome: null,
      usageCount: 0,
      lastUsed: null,
      createdAt: '2026-04-01',
      contentPreview: 'Architecture principle.',
    };
    db.insertMemory(record);

    tracker.trackReferences(['known.md']);

    const updated = db.getMemory('known.md');
    expect(updated!.usageCount).toBe(1);
  });

  it('ignores unknown references gracefully', () => {
    const record: MemoryRecord = {
      id: 'known.md',
      agentId: 'huahua',
      type: 'principle',
      topic: 'architecture',
      confidence: 0.9,
      outcome: null,
      usageCount: 0,
      lastUsed: null,
      createdAt: '2026-04-01',
      contentPreview: 'Architecture principle.',
    };
    db.insertMemory(record);

    // Track both unknown and known — should not throw
    tracker.trackReferences(['nonexistent.md', 'known.md']);

    const updated = db.getMemory('known.md');
    expect(updated!.usageCount).toBe(1);

    const missing = db.getMemory('nonexistent.md');
    expect(missing).toBeNull();
  });
});
