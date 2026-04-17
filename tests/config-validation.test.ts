import { describe, it, expect, beforeEach } from 'vitest';
import { loadAgentConfig } from '../src/config.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('loadAgentConfig — validation', () => {
  const testDir = join(tmpdir(), 'agent-council-test-validation');

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(join(testDir, 'agents'), { recursive: true });
  });

  it('throws when enabled-mode thinking budget_tokens is not a number', () => {
    const yaml = `
id: binbin
name: 賓賓
provider: claude
model: claude-opus-4-7
memory_dir: 賓賓/global
personality: |
  You are 賓賓.
thinking:
  high:
    mode: enabled
    budget_tokens: "32k"
`;
    writeFileSync(join(testDir, 'agents', 'bad-thinking.yaml'), yaml);
    expect(() => loadAgentConfig(join(testDir, 'agents', 'bad-thinking.yaml'))).toThrow(
      /budget_tokens.*number/i,
    );
  });

  it('throws when thinking mode is neither adaptive nor enabled', () => {
    const yaml = `
id: binbin
name: 賓賓
provider: claude
model: claude-opus-4-7
memory_dir: 賓賓/global
personality: |
  You are 賓賓.
thinking:
  high:
    budget_tokens: 32000
`;
    writeFileSync(join(testDir, 'agents', 'missing-mode.yaml'), yaml);
    expect(() => loadAgentConfig(join(testDir, 'agents', 'missing-mode.yaml'))).toThrow(
      /mode must be 'adaptive' or 'enabled'/,
    );
  });

  it('accepts enabled mode with numeric budget_tokens', () => {
    const yaml = `
id: binbin
name: 賓賓
provider: claude
model: claude-opus-4-7
memory_dir: 賓賓/global
personality: |
  You are 賓賓.
thinking:
  high:
    mode: enabled
    budget_tokens: 32000
`;
    writeFileSync(join(testDir, 'agents', 'good-thinking.yaml'), yaml);
    const config = loadAgentConfig(join(testDir, 'agents', 'good-thinking.yaml'));
    expect(config.thinking?.high).toEqual({ mode: 'enabled', budget_tokens: 32000 });
  });
});
