import { describe, it, expect, beforeEach } from 'vitest';
import { MemorySyncLoader } from '../../src/memory/loader.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('MemorySyncLoader', () => {
  const testDir = join(tmpdir(), 'agent-council-test-memory');
  const agentDir = join(testDir, '花花', 'global');
  let loader: MemorySyncLoader;

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(agentDir, { recursive: true });

    writeFileSync(join(agentDir, 'MEMORY.md'), `# Memory Index

- [user_profile.md](user_profile.md) — HEEACT 品保工作者
- [feedback_writing.md](feedback_writing.md) — 中文寫作偏好
`);

    writeFileSync(join(agentDir, 'user_profile.md'), `---
name: User Profile
description: HEEACT 品保工作者
type: user
---

User is a QA professional at HEEACT.
`);

    writeFileSync(join(agentDir, 'feedback_writing.md'), `---
name: Writing Feedback
description: 中文寫作偏好
type: feedback
---

No AI slop. No dash abuse.
`);

    loader = new MemorySyncLoader(testDir);
  });

  it('loads memory index from MEMORY.md', () => {
    const index = loader.loadIndex('花花/global');
    expect(index).toContain('user_profile.md');
    expect(index).toContain('feedback_writing.md');
  });

  it('loads a specific memory file content', () => {
    const content = loader.loadMemory('花花/global', 'user_profile.md');
    expect(content).toContain('HEEACT');
    expect(content).toContain('QA professional');
  });

  it('returns empty string for missing memory', () => {
    const content = loader.loadMemory('花花/global', 'nonexistent.md');
    expect(content).toBe('');
  });

  it('loads all memory files for an agent', () => {
    const all = loader.loadAllMemories('花花/global');
    expect(all).toHaveLength(2);
    expect(all[0].filename).toBe('feedback_writing.md');
    expect(all[1].filename).toBe('user_profile.md');
  });

  it('has progressive disclosure methods', () => {
    // searchMemories and getMemoryMeta return empty/null without DB
    expect(loader.searchMemories('test')).toEqual([]);
    expect(loader.getMemoryMeta('test.md')).toBeNull();
  });
});
