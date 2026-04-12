import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface MemoryEntry {
  filename: string;
  content: string;
}

export class MemorySyncLoader {
  private basePath: string;

  constructor(memorySyncPath: string) {
    this.basePath = memorySyncPath;
  }

  loadIndex(memoryDir: string): string {
    const indexPath = join(this.basePath, memoryDir, 'MEMORY.md');
    if (!existsSync(indexPath)) {
      return '';
    }
    return readFileSync(indexPath, 'utf-8');
  }

  loadMemory(memoryDir: string, filename: string): string {
    const filePath = join(this.basePath, memoryDir, filename);
    if (!existsSync(filePath)) {
      return '';
    }
    return readFileSync(filePath, 'utf-8');
  }

  loadAllMemories(memoryDir: string): MemoryEntry[] {
    const dirPath = join(this.basePath, memoryDir);
    if (!existsSync(dirPath)) {
      return [];
    }

    const files = readdirSync(dirPath)
      .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
      .sort();

    return files.map((filename) => ({
      filename,
      content: readFileSync(join(dirPath, filename), 'utf-8'),
    }));
  }
}
