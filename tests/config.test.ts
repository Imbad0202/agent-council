import { describe, it, expect, beforeEach } from 'vitest';
import { loadAgentConfig, loadCouncilConfig } from '../src/config.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('config', () => {
  const testDir = join(tmpdir(), 'agent-council-test-config');

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(join(testDir, 'agents'), { recursive: true });
  });

  describe('loadAgentConfig', () => {
    it('parses a YAML agent config file', () => {
      const yamlContent = `
id: testbot
name: TestBot
provider: claude
model: claude-opus-4-6
memory_dir: TestBot/global
personality: |
  You are TestBot.
`;
      writeFileSync(join(testDir, 'agents', 'testbot.yaml'), yamlContent);
      const config = loadAgentConfig(join(testDir, 'agents', 'testbot.yaml'));
      expect(config.id).toBe('testbot');
      expect(config.name).toBe('TestBot');
      expect(config.provider).toBe('claude');
      expect(config.model).toBe('claude-opus-4-6');
      expect(config.memoryDir).toBe('TestBot/global');
      expect(config.personality).toContain('You are TestBot.');
    });

    it('throws on missing required fields', () => {
      writeFileSync(join(testDir, 'agents', 'bad.yaml'), 'id: bad\n');
      expect(() => loadAgentConfig(join(testDir, 'agents', 'bad.yaml'))).toThrow();
    });
  });

  describe('loadCouncilConfig', () => {
    it('parses council.yaml with defaults', () => {
      const yamlContent = `
gateway:
  thinking_window_ms: 3000
  random_delay_ms: [1000, 2000]
  max_inter_agent_rounds: 2
  context_window_turns: 8
  session_max_turns: 15
anti_sycophancy:
  disagreement_threshold: 0.2
  consecutive_low_rounds: 3
  challenge_angles: [cost, risk]
roles:
  default_2_agents: [advocate, critic]
  topic_overrides:
    code: [author, reviewer]
`;
      writeFileSync(join(testDir, 'council.yaml'), yamlContent);
      const config = loadCouncilConfig(join(testDir, 'council.yaml'));
      expect(config.gateway.thinkingWindowMs).toBe(3000);
      expect(config.gateway.randomDelayMs).toEqual([1000, 2000]);
      expect(config.antiSycophancy.disagreementThreshold).toBe(0.2);
      expect(config.roles.default2Agents).toEqual(['advocate', 'critic']);
      expect(config.roles.topicOverrides.code).toEqual(['author', 'reviewer']);
    });

    it('parses memory and anti_pattern config sections', () => {
      const yamlContent = `
gateway:
  thinking_window_ms: 3000
  random_delay_ms: [1000, 2000]
  max_inter_agent_rounds: 2
  context_window_turns: 8
  session_max_turns: 15
anti_sycophancy:
  disagreement_threshold: 0.2
  consecutive_low_rounds: 3
  challenge_angles: [cost, risk]
roles:
  default_2_agents: [advocate, critic]
  topic_overrides:
    code: [author, reviewer]
memory:
  db_path: data/brain.db
  session_timeout_ms: 600000
  end_keywords: ["結束", "done", "結論"]
  archive_threshold: 30
  archive_bottom_percent: 20
  consolidation_threshold: 5
anti_pattern:
  enabled: true
  detection_model: claude-haiku-4-5-20251001
  start_after_turn: 3
  detect_every_n_turns: 2
`;
      writeFileSync(join(testDir, 'council2.yaml'), yamlContent);
      const config = loadCouncilConfig(join(testDir, 'council2.yaml'));
      expect(config.memory?.dbPath).toBe('data/brain.db');
      expect(config.memory?.endKeywords).toContain('結束');
      expect(config.memory?.archiveThreshold).toBe(30);
      expect(config.antiPattern?.enabled).toBe(true);
      expect(config.antiPattern?.detectionModel).toBe('claude-haiku-4-5-20251001');
    });
  });
});
