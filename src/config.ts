import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { AgentConfig, CouncilConfig } from './types.js';

export function loadAgentConfig(filePath: string): AgentConfig {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parse(raw);

  if (!parsed.id || !parsed.name || !parsed.provider || !parsed.model || !parsed.memory_dir || !parsed.personality) {
    throw new Error(`Invalid agent config at ${filePath}: missing required fields (id, name, provider, model, memory_dir, personality)`);
  }

  return {
    id: parsed.id,
    name: parsed.name,
    provider: parsed.provider,
    model: parsed.model,
    memoryDir: parsed.memory_dir,
    personality: parsed.personality.trim(),
  };
}

export function loadCouncilConfig(filePath: string): CouncilConfig {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parse(raw);

  return {
    gateway: {
      thinkingWindowMs: parsed.gateway.thinking_window_ms,
      randomDelayMs: parsed.gateway.random_delay_ms,
      maxInterAgentRounds: parsed.gateway.max_inter_agent_rounds,
      contextWindowTurns: parsed.gateway.context_window_turns,
      sessionMaxTurns: parsed.gateway.session_max_turns,
    },
    antiSycophancy: {
      disagreementThreshold: parsed.anti_sycophancy.disagreement_threshold,
      consecutiveLowRounds: parsed.anti_sycophancy.consecutive_low_rounds,
      challengeAngles: parsed.anti_sycophancy.challenge_angles,
    },
    roles: {
      default2Agents: parsed.roles.default_2_agents,
      topicOverrides: parsed.roles.topic_overrides ?? {},
    },
  };
}
