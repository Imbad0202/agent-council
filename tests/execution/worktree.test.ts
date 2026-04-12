import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeManager } from '../../src/execution/worktree.js';

function createTempRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'council-repo-'));
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, stdio: 'pipe' });
  return repoPath;
}

describe('WorktreeManager', () => {
  let repoPath: string;
  let manager: WorktreeManager;

  beforeEach(() => {
    repoPath = createTempRepo();
    manager = new WorktreeManager(repoPath, 3);
  });

  afterEach(async () => {
    await manager.removeAll();
    rmSync(repoPath, { recursive: true, force: true });
  });

  it('creates a worktree with correct branch name and path exists', async () => {
    const info = await manager.create('task-abc');

    expect(info.taskId).toBe('task-abc');
    expect(info.branch).toBe('council/task-abc');
    expect(info.path).toContain('council-task-abc-');
    expect(existsSync(info.path)).toBe(true);
  });

  it('removes a worktree and path no longer exists', async () => {
    const info = await manager.create('task-remove');
    expect(existsSync(info.path)).toBe(true);

    await manager.remove('task-remove');
    expect(existsSync(info.path)).toBe(false);
    expect(manager.get('task-remove')).toBeUndefined();
  });

  it('lists active worktrees', async () => {
    await manager.create('task-1');
    await manager.create('task-2');

    const list = manager.list();
    expect(list).toHaveLength(2);
    expect(list.map(w => w.taskId)).toContain('task-1');
    expect(list.map(w => w.taskId)).toContain('task-2');
  });

  it('reports capacity correctly when at maxConcurrent', async () => {
    expect(manager.isAtCapacity()).toBe(false);

    await manager.create('task-cap-1');
    await manager.create('task-cap-2');
    await manager.create('task-cap-3');

    expect(manager.isAtCapacity()).toBe(true);
    await expect(manager.create('task-cap-4')).rejects.toThrow('Max concurrent worktrees reached (3)');
  });

  it('removeAll cleans up all active worktrees', async () => {
    const info1 = await manager.create('task-all-1');
    const info2 = await manager.create('task-all-2');

    await manager.removeAll();

    expect(manager.list()).toHaveLength(0);
    expect(existsSync(info1.path)).toBe(false);
    expect(existsSync(info2.path)).toBe(false);
  });
});
