import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface WorktreeInfo {
  taskId: string;
  path: string;
  branch: string;
  createdAt: number;
}

export class WorktreeManager {
  private active: Map<string, WorktreeInfo> = new Map();
  private maxConcurrent: number;
  private repoPath: string;

  constructor(repoPath: string, maxConcurrent: number) {
    this.repoPath = repoPath;
    this.maxConcurrent = maxConcurrent;
  }

  async create(taskId: string): Promise<WorktreeInfo> {
    if (this.isAtCapacity()) throw new Error(`Max concurrent worktrees reached (${this.maxConcurrent})`);
    const branch = `council/${taskId}`;
    const worktreePath = join(tmpdir(), `council-${taskId}-${Date.now()}`);
    execFileSync('git', ['worktree', 'add', worktreePath, '-b', branch], { cwd: this.repoPath, stdio: 'pipe' });
    const info: WorktreeInfo = { taskId, path: worktreePath, branch, createdAt: Date.now() };
    this.active.set(taskId, info);
    return info;
  }

  async remove(taskId: string): Promise<void> {
    const info = this.active.get(taskId);
    if (!info) return;
    try { execFileSync('git', ['worktree', 'remove', info.path, '--force'], { cwd: this.repoPath, stdio: 'pipe' }); } catch {}
    try { execFileSync('git', ['branch', '-D', info.branch], { cwd: this.repoPath, stdio: 'pipe' }); } catch {}
    this.active.delete(taskId);
  }

  async removeAll(): Promise<void> {
    for (const taskId of [...this.active.keys()]) await this.remove(taskId);
  }

  list(): WorktreeInfo[] { return [...this.active.values()]; }
  isAtCapacity(): boolean { return this.active.size >= this.maxConcurrent; }
  get(taskId: string): WorktreeInfo | undefined { return this.active.get(taskId); }
}
