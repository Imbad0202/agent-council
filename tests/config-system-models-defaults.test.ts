import { describe, it, expect, beforeEach } from 'vitest';
import { loadCouncilConfig } from '../src/config.js';
import { DEFAULT_SYSTEM_MODEL } from '../src/constants.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const MINIMAL_BASE = `
gateway:
  thinking_window_ms: 5000
  random_delay_ms: [1000, 3000]
  max_inter_agent_rounds: 3
  context_window_turns: 10
  session_max_turns: 20
anti_sycophancy:
  disagreement_threshold: 0.2
  consecutive_low_rounds: 3
  challenge_angles: [cost]
roles:
  default_2_agents: [advocate, critic]
`;

describe('loadCouncilConfig — systemModels defaults', () => {
  const testDir = join(tmpdir(), 'agent-council-test-system-models');

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  });

  it('applies DEFAULT_SYSTEM_MODEL to both fields when system_models block is absent', () => {
    writeFileSync(join(testDir, 'council.yaml'), MINIMAL_BASE);
    const config = loadCouncilConfig(join(testDir, 'council.yaml'));
    expect(config.systemModels).toBeDefined();
    expect(config.systemModels!.intentClassification).toBe(DEFAULT_SYSTEM_MODEL);
    expect(config.systemModels!.taskDecomposition).toBe(DEFAULT_SYSTEM_MODEL);
  });

  it('fills missing individual fields with DEFAULT_SYSTEM_MODEL', () => {
    const yaml = MINIMAL_BASE + `
system_models:
  intent_classification: claude-sonnet-4-6
`;
    writeFileSync(join(testDir, 'council.yaml'), yaml);
    const config = loadCouncilConfig(join(testDir, 'council.yaml'));
    expect(config.systemModels!.intentClassification).toBe('claude-sonnet-4-6');
    expect(config.systemModels!.taskDecomposition).toBe(DEFAULT_SYSTEM_MODEL);
  });

  it('honors both fields when set', () => {
    const yaml = MINIMAL_BASE + `
system_models:
  intent_classification: claude-opus-4-7
  task_decomposition: claude-sonnet-4-6
`;
    writeFileSync(join(testDir, 'council.yaml'), yaml);
    const config = loadCouncilConfig(join(testDir, 'council.yaml'));
    expect(config.systemModels!.intentClassification).toBe('claude-opus-4-7');
    expect(config.systemModels!.taskDecomposition).toBe('claude-sonnet-4-6');
  });
});
