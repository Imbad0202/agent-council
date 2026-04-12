import type { MemoryDB } from './db.js';

const REF_REGEX = /\[ref:([^\]]+)\]/g;

export class UsageTracker {
  private db: MemoryDB;

  constructor(db: MemoryDB) {
    this.db = db;
  }

  extractReferences(content: string): string[] {
    const refs: string[] = [];
    let match: RegExpExecArray | null;
    const regex = new RegExp(REF_REGEX.source, REF_REGEX.flags);
    while ((match = regex.exec(content)) !== null) {
      refs.push(match[1]);
    }
    return refs;
  }

  trackReferences(filenames: string[]): void {
    const date = new Date().toISOString().slice(0, 10);
    for (const filename of filenames) {
      const record = this.db.getMemory(filename);
      if (record) {
        this.db.incrementUsage(filename, date);
      }
    }
  }
}
