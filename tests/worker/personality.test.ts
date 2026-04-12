import { describe, it, expect, beforeEach } from 'vitest';
import { buildSystemPrompt } from '../../src/worker/personality.js';
import type { AgentConfig, AgentRole } from '../../src/types.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('buildSystemPrompt', () => {
  const testDir = join(tmpdir(), 'agent-council-test-personality');
  const agentDir = join(testDir, '花花', 'global');

  const agentConfig: AgentConfig = {
    id: 'huahua',
    name: '花花',
    provider: 'claude',
    model: 'claude-opus-4-6',
    memoryDir: '花花/global',
    personality: 'You are 花花. You have strong opinions.',
  };

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(agentDir, { recursive: true });

    writeFileSync(join(agentDir, 'MEMORY.md'), `# Memory Index
- [user_profile.md](user_profile.md) — User is a QA pro
`);
    writeFileSync(join(agentDir, 'user_profile.md'), `---
name: User Profile
type: user
---
User works at HEEACT.
`);
  });

  it('combines personality + memory + role into system prompt', () => {
    const prompt = buildSystemPrompt(agentConfig, testDir, 'critic');
    expect(prompt).toContain('You are 花花');
    expect(prompt).toContain('user_profile.md');
    expect(prompt).toContain('critic');
  });

  it('includes iron rule anchor for the role', () => {
    const prompt = buildSystemPrompt(agentConfig, testDir, 'critic');
    expect(prompt).toContain('IRON RULE');
    expect(prompt).toContain('flaw');
  });

  it('works without memory files', () => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(agentDir, { recursive: true });
    const prompt = buildSystemPrompt(agentConfig, testDir, 'advocate');
    expect(prompt).toContain('You are 花花');
    expect(prompt).toContain('advocate');
  });
});
