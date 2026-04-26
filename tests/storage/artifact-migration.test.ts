import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { ArtifactDB } from '../../src/council/artifact-db.js';
import { ResetSnapshotDB } from '../../src/storage/reset-snapshot-db.js';
import { MemoryDB } from '../../src/memory/db.js';

describe('council_artifacts migration scoping', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'artifact-migration-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('council.db: existing tables preserved + council_artifacts table appears empty', () => {
    const councilPath = resolve(tmpDir, 'council.db');

    // Pre-populate council.db with a reset snapshot using ResetSnapshotDB
    const reset = new ResetSnapshotDB(councilPath);
    reset.recordSnapshot({
      snapshotId: 'a',
      threadId: 1,
      segmentIndex: 0,
      sealedAt: 't',
      summaryMarkdown: '#',
      metadata: { openQuestionsCount: 0, decisionsCount: 0, blindReviewSessionId: null },
    });
    const beforeCount = reset.listSnapshotsForThread(1).length;
    reset.close();

    // Now run artifact migration on the same council.db path
    const artifact = new ArtifactDB(councilPath);

    // Re-open ResetSnapshotDB — existing table and rows must be preserved
    const resetReopen = new ResetSnapshotDB(councilPath);
    expect(resetReopen.listSnapshotsForThread(1).length).toBe(beforeCount);

    // council_artifacts table must exist and be empty
    expect(artifact.findByThread(1)).toEqual([]);

    artifact.close();
    resetReopen.close();
  });

  it('brain.db: artifact migration does NOT create council_artifacts table in brain.db', () => {
    const brainPath = resolve(tmpDir, 'brain.db');

    // Pre-populate brain.db with a memory row via MemoryDB
    const memoryDb = new MemoryDB(brainPath);
    memoryDb.insertMemory({
      id: 'mem-001',
      agentId: 'agent-a',
      type: 'session',
      topic: 'test topic',
      confidence: 0.8,
      outcome: null,
      usageCount: 0,
      lastUsed: null,
      createdAt: new Date().toISOString(),
      contentPreview: 'test memory content',
    });
    memoryDb.close();

    // Run artifact migration on a DIFFERENT path (council.db, not brain.db)
    const councilPath = resolve(tmpDir, 'council.db');
    new ArtifactDB(councilPath).close();

    // Re-open brain.db raw and verify council_artifacts is NOT in its schema
    const raw = new Database(brainPath);
    const tables = raw.prepare(
      `SELECT name FROM sqlite_master WHERE type='table'`
    ).all() as { name: string }[];
    raw.close();

    expect(tables.some(t => t.name === 'council_artifacts')).toBe(false);
    // Sanity check: brain.db still has its own tables intact
    expect(tables.some(t => t.name === 'memories')).toBe(true);
  });
});
