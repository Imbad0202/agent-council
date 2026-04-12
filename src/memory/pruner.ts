import { renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import type { MemoryDB } from './db.js';
import type { MemoryRecord } from '../types.js';

export class MemoryPruner {
  private db: MemoryDB;
  private dataDir: string;

  constructor(db: MemoryDB, dataDir: string) {
    this.db = db;
    this.dataDir = dataDir;
  }

  identifyForArchiving(agentId: string, bottomPercent: number): MemoryRecord[] {
    return this.db.getLowestScoredMemories(agentId, bottomPercent);
  }

  archiveMemories(agentId: string, bottomPercent: number): MemoryRecord[] {
    const toArchive = this.identifyForArchiving(agentId, bottomPercent);

    for (const record of toArchive) {
      this.db.updateType(record.id, 'archive');

      const filename = basename(record.id);
      const sourcePath = join(this.dataDir, record.id);
      const archiveDir = join(this.dataDir, agentId, 'archive');
      const destPath = join(archiveDir, filename);

      mkdirSync(archiveDir, { recursive: true });
      if (existsSync(sourcePath)) {
        renameSync(sourcePath, destPath);
      }
    }

    return toArchive;
  }

  restoreIfArchived(memoryId: string, agentId: string): boolean {
    const record = this.db.getMemory(memoryId);
    if (!record || record.type !== 'archive') return false;

    const originalType = memoryId.includes('/sessions/') ? 'session' : 'principle';
    this.db.updateType(memoryId, originalType as MemoryRecord['type']);

    const filename = basename(memoryId);
    const archivePath = join(this.dataDir, agentId, 'archive', filename);
    const restorePath = join(this.dataDir, memoryId);

    mkdirSync(dirname(restorePath), { recursive: true });
    if (existsSync(archivePath)) {
      renameSync(archivePath, restorePath);
    }

    return true;
  }
}
