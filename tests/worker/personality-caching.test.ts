import { describe, it, expect, beforeEach } from 'vitest';
import { buildSystemPromptParts } from '../../src/worker/personality.js';
import type { AgentConfig } from '../../src/types.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('buildSystemPromptParts — stable/volatile split for caching', () => {
  const testDir = join(tmpdir(), 'agent-council-test-personality-caching');
  const agentDir = join(testDir, 'binbin', 'global');

  const agentConfig: AgentConfig = {
    id: 'binbin',
    name: '賓賓',
    provider: 'claude',
    model: 'claude-opus-4-7',
    memoryDir: 'binbin/global',
    personality: 'You are 賓賓.',
  };

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'MEMORY.md'), '# Memory Index\n- [x.md](x.md) — test\n');
  });

  it('returns { stable, volatile } where volatile contains the role', () => {
    const parts = buildSystemPromptParts(agentConfig, testDir, 'critic');
    expect(parts.volatile).toContain('critic');
    expect(parts.volatile).toContain('IRON RULE');
  });

  it('stable contains personality, memory index, and council rules', () => {
    const parts = buildSystemPromptParts(agentConfig, testDir, 'critic');
    expect(parts.stable).toContain('You are 賓賓');
    expect(parts.stable).toContain('Memory Index');
    expect(parts.stable).toContain('Council Rules');
  });

  it('stable is byte-identical across different roles (cache-safe)', () => {
    const a = buildSystemPromptParts(agentConfig, testDir, 'critic');
    const b = buildSystemPromptParts(agentConfig, testDir, 'advocate');
    const c = buildSystemPromptParts(agentConfig, testDir, 'analyst');
    expect(a.stable).toBe(b.stable);
    expect(b.stable).toBe(c.stable);
  });

  it('volatile differs across roles', () => {
    const a = buildSystemPromptParts(agentConfig, testDir, 'critic');
    const b = buildSystemPromptParts(agentConfig, testDir, 'advocate');
    expect(a.volatile).not.toBe(b.volatile);
  });

  it('stable does not mention any role name (role is fully in volatile)', () => {
    const parts = buildSystemPromptParts(agentConfig, testDir, 'critic');
    expect(parts.stable.toLowerCase()).not.toContain('current role');
    expect(parts.stable).not.toContain('critic');
    expect(parts.stable).not.toContain('advocate');
  });
});
