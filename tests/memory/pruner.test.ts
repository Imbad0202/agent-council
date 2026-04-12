import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryPruner } from '../../src/memory/pruner.js';
import { MemoryDB } from '../../src/memory/db.js';
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MemoryRecord } from '../../src/types.js';

describe('MemoryPruner', () => {
  const testDir = join(tmpdir(), 'agent-council-pruner-test');
  const testDbPath = join(testDir, 'brain.db');
  const dataDir = join(testDir, 'data');
  let db: MemoryDB;
  let pruner: MemoryPruner;

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(join(dataDir, 'huahua', 'sessions'), { recursive: true });
    mkdirSync(join(dataDir, 'huahua', 'archive'), { recursive: true });

    db = new MemoryDB(testDbPath);
    pruner = new MemoryPruner(db, dataDir);

    // Insert 5 memories with usage_count 0–4
    for (let i = 0; i < 5; i++) {
      const id = `huahua/sessions/session-${i}.md`;
      const record: MemoryRecord = {
        id,
        agentId: 'huahua',
        type: 'session',
        topic: `topic-${i}`,
        confidence: 0.7,
        outcome: null,
        usageCount: i,
        lastUsed: i > 0 ? '2026-04-10' : null,
        createdAt: '2026-04-01',
        contentPreview: `Session ${i} content.`,
      };
      db.insertMemory(record);
      writeFileSync(join(dataDir, id), `# Session ${i}\nContent here.`);
    }
  });

  afterEach(() => {
    db.close();
  });

  it('identifyForArchiving returns bottom 20% memories', () => {
    const candidates = pruner.identifyForArchiving('huahua', 20);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe('huahua/sessions/session-0.md');
    expect(candidates[0].usageCount).toBe(0);
  });

  it('archiveMemories moves files and updates DB type', () => {
    const archived = pruner.archiveMemories('huahua', 20);
    expect(archived).toHaveLength(1);
    expect(archived[0].id).toBe('huahua/sessions/session-0.md');

    // DB type updated to archive
    const record = db.getMemory('huahua/sessions/session-0.md');
    expect(record!.type).toBe('archive');

    // File moved to archive directory
    const archivePath = join(dataDir, 'huahua', 'archive', 'session-0.md');
    expect(existsSync(archivePath)).toBe(true);

    // Source file removed
    const sourcePath = join(dataDir, 'huahua', 'sessions', 'session-0.md');
    expect(existsSync(sourcePath)).toBe(false);
  });

  it('restoreIfArchived moves file back and restores DB type', () => {
    // Archive first
    pruner.archiveMemories('huahua', 20);

    // Verify archived state
    const before = db.getMemory('huahua/sessions/session-0.md');
    expect(before!.type).toBe('archive');

    // Restore
    const restored = pruner.restoreIfArchived('huahua/sessions/session-0.md', 'huahua');
    expect(restored).toBe(true);

    // DB type restored to session
    const after = db.getMemory('huahua/sessions/session-0.md');
    expect(after!.type).toBe('session');

    // File moved back to original location
    const sourcePath = join(dataDir, 'huahua', 'sessions', 'session-0.md');
    expect(existsSync(sourcePath)).toBe(true);

    // Archive file removed
    const archivePath = join(dataDir, 'huahua', 'archive', 'session-0.md');
    expect(existsSync(archivePath)).toBe(false);
  });
});
