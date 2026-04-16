import { describe, it, expect, beforeEach } from 'vitest';
import { loadAgentConfig } from '../src/config.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('loadAgentConfig — thinking', () => {
  const testDir = join(tmpdir(), 'agent-council-test-thinking');

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(join(testDir, 'agents'), { recursive: true });
  });

  it('parses thinking tier config from YAML', () => {
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
    writeFileSync(join(testDir, 'agents', 'binbin.yaml'), yaml);
    const config = loadAgentConfig(join(testDir, 'agents', 'binbin.yaml'));
    expect(config.thinking?.high).toEqual({ budget_tokens: 32000 });
  });

  it('omits thinking field when not in YAML', () => {
    const yaml = `
id: simple
name: Simple
provider: claude
model: claude-sonnet-4-6
memory_dir: simple/global
personality: |
  Simple agent.
`;
    writeFileSync(join(testDir, 'agents', 'simple.yaml'), yaml);
    const config = loadAgentConfig(join(testDir, 'agents', 'simple.yaml'));
    expect(config.thinking).toBeUndefined();
  });

  it('parses thinking for multiple tiers', () => {
    const yaml = `
id: multi
name: Multi
provider: claude
model: claude-opus-4-7
memory_dir: multi/global
personality: |
  Multi.
thinking:
  medium:
    budget_tokens: 8000
  high:
    budget_tokens: 32000
`;
    writeFileSync(join(testDir, 'agents', 'multi.yaml'), yaml);
    const config = loadAgentConfig(join(testDir, 'agents', 'multi.yaml'));
    expect(config.thinking?.medium).toEqual({ budget_tokens: 8000 });
    expect(config.thinking?.high).toEqual({ budget_tokens: 32000 });
  });
});
