import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { AgentWorker } from '../worker/agent-worker.js';
import type { ExecutionTask } from '../types.js';

interface CodeGenResult {
  files: Array<{ path: string; content: string }>;
  commitMessage: string;
}

export class Executor {
  private worker: AgentWorker;
  private timeoutMs: number;

  constructor(worker: AgentWorker, timeoutMs: number) {
    this.worker = worker;
    this.timeoutMs = timeoutMs;
  }

  async execute(task: ExecutionTask): Promise<ExecutionTask> {
    task.status = 'running';
    try {
      const response = await this.worker.respond(
        [{ id: 'task', role: 'human', content: task.description, timestamp: Date.now() }],
        'author',
        `You are implementing a coding task in an isolated git worktree.\n\nTask: ${task.description}\n\nRespond in JSON: {"files": [{"path": "relative/path.ts", "content": "full content"}], "commitMessage": "feat: ..."}`,
      );
      const codeGen = JSON.parse(response.content) as CodeGenResult;

      const filesChanged: string[] = [];
      for (const file of codeGen.files) {
        const fullPath = join(task.worktreePath, file.path);
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, file.content, 'utf-8');
        filesChanged.push(file.path);
      }

      // Use execFileSync for safety
      execFileSync('git', ['add', '-A'], { cwd: task.worktreePath, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', codeGen.commitMessage], { cwd: task.worktreePath, stdio: 'pipe' });

      const diff = execFileSync('git', ['diff', 'HEAD~1'], {
        cwd: task.worktreePath,
        encoding: 'utf-8',
      });
      const commitHash = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: task.worktreePath,
        encoding: 'utf-8',
      }).trim();

      task.status = 'completed';
      task.result = { diff, filesChanged, commitHash };
    } catch (err) {
      task.status = 'failed';
      task.error = err instanceof Error ? err.message : String(err);
    }
    return task;
  }
}
