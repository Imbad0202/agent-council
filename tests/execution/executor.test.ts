import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Executor } from '../../src/execution/executor.js';
import type { AgentWorker } from '../../src/worker/agent-worker.js';
import type { ExecutionTask, ProviderResponse } from '../../src/types.js';

function makeWorker(content: string): AgentWorker {
  return {
    id: 'worker-1',
    name: 'Test Worker',
    respond: vi.fn<[], Promise<ProviderResponse>>().mockResolvedValue({
      content,
      tokensUsed: { input: 10, output: 50 },
    }),
  } as unknown as AgentWorker;
}

function makeTask(overrides: Partial<ExecutionTask> = {}): ExecutionTask {
  return {
    id: 'task-1',
    description: 'Add a hello world function',
    assignedAgent: 'worker-1',
    worktreePath: '',
    branch: '',
    status: 'pending',
    ...overrides,
  };
}

function initGitRepo(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'pipe' });
  // Create an initial commit so HEAD~1 works after executor commits
  execFileSync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: dir, stdio: 'pipe' });
}

describe('Executor', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'executor-test-'));
    initGitRepo(repoDir);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('executes task, writes files, commits, and returns completed result with diff', async () => {
    const codeGenResponse = JSON.stringify({
      files: [
        { path: 'src/hello.ts', content: 'export function hello() { return "world"; }' },
      ],
      commitMessage: 'feat: add hello world function',
    });

    const worker = makeWorker(codeGenResponse);
    const executor = new Executor(worker, 30_000);

    const task = makeTask({ worktreePath: repoDir });
    const result = await executor.execute(task);

    expect(result.status).toBe('completed');
    expect(result.result).toBeDefined();
    expect(result.result!.filesChanged).toContain('src/hello.ts');
    expect(result.result!.commitHash).toMatch(/^[0-9a-f]{40}$/);
    expect(result.result!.diff).toContain('hello');
    expect(result.error).toBeUndefined();
  });

  it('writes multiple files and commits them all', async () => {
    const codeGenResponse = JSON.stringify({
      files: [
        { path: 'src/a.ts', content: 'export const A = 1;' },
        { path: 'src/b.ts', content: 'export const B = 2;' },
      ],
      commitMessage: 'feat: add A and B modules',
    });

    const worker = makeWorker(codeGenResponse);
    const executor = new Executor(worker, 30_000);

    const task = makeTask({ worktreePath: repoDir });
    const result = await executor.execute(task);

    expect(result.status).toBe('completed');
    expect(result.result!.filesChanged).toContain('src/a.ts');
    expect(result.result!.filesChanged).toContain('src/b.ts');
  });

  it('marks task as failed when worker.respond throws an error', async () => {
    const worker = {
      id: 'worker-err',
      name: 'Error Worker',
      respond: vi.fn<[], Promise<ProviderResponse>>().mockRejectedValue(new Error('LLM timeout')),
    } as unknown as AgentWorker;

    const executor = new Executor(worker, 30_000);
    const task = makeTask({ worktreePath: repoDir });
    const result = await executor.execute(task);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('LLM timeout');
    expect(result.result).toBeUndefined();
  });

  it('marks task as failed when response is not valid JSON', async () => {
    const worker = makeWorker('not valid json at all');
    const executor = new Executor(worker, 30_000);

    const task = makeTask({ worktreePath: repoDir });
    const result = await executor.execute(task);

    expect(result.status).toBe('failed');
    expect(result.error).toBeTruthy();
  });

  it('passes task description and challenge prompt to worker.respond', async () => {
    const codeGenResponse = JSON.stringify({
      files: [{ path: 'src/noop.ts', content: 'export {}' }],
      commitMessage: 'feat: noop',
    });

    const worker = makeWorker(codeGenResponse);
    const executor = new Executor(worker, 30_000);

    const task = makeTask({ worktreePath: repoDir, description: 'My specific task' });
    await executor.execute(task);

    const respondMock = worker.respond as ReturnType<typeof vi.fn>;
    expect(respondMock).toHaveBeenCalledOnce();
    const [history, role, challengePrompt] = respondMock.mock.calls[0] as [unknown[], string, string];
    expect(role).toBe('author');
    expect(challengePrompt).toContain('My specific task');
    expect((history[0] as { content: string }).content).toBe('My specific task');
  });
});
