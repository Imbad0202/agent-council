import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { AgentConfig, CouncilConfig } from './types.js';
import { DEFAULT_SYSTEM_MODEL } from './constants.js';

export function loadAgentConfig(filePath: string): AgentConfig {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parse(raw);

  if (!parsed.id || !parsed.name || !parsed.provider || !parsed.model || !parsed.memory_dir || !parsed.personality) {
    throw new Error(`Invalid agent config at ${filePath}: missing required fields (id, name, provider, model, memory_dir, personality)`);
  }

  if (parsed.thinking) {
    for (const [tier, cfg] of Object.entries(parsed.thinking)) {
      const entry = cfg as { mode?: unknown; budget_tokens?: unknown };
      if (entry?.mode === 'adaptive') continue;
      if (entry?.mode === 'enabled') {
        if (typeof entry.budget_tokens !== 'number' || !Number.isFinite(entry.budget_tokens)) {
          throw new Error(`Invalid agent config at ${filePath}: thinking.${tier}.budget_tokens must be a finite number when mode=enabled, got ${JSON.stringify(entry.budget_tokens)}`);
        }
        continue;
      }
      throw new Error(`Invalid agent config at ${filePath}: thinking.${tier}.mode must be 'adaptive' or 'enabled', got ${JSON.stringify(entry?.mode)}`);
    }
  }

  return {
    id: parsed.id,
    name: parsed.name,
    provider: parsed.provider,
    model: parsed.model,
    memoryDir: parsed.memory_dir,
    personality: parsed.personality.trim(),
    botTokenEnv: parsed.bot_token_env,
    topics: parsed.topics,
    roleType: parsed.role_type,
    models: parsed.models,
    defaultModelTier: parsed.default_model_tier,
    thinking: parsed.thinking,
    cacheSystemPrompt: parsed.cache_system_prompt,
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
    memory: {
      dbPath: parsed.memory?.db_path ?? 'data/brain.db',
      sessionTimeoutMs: parsed.memory?.session_timeout_ms ?? 600000,
      endKeywords: parsed.memory?.end_keywords ?? ['結束', 'done', '結論', 'wrap up', '總結'],
      archiveThreshold: parsed.memory?.archive_threshold ?? 30,
      archiveBottomPercent: parsed.memory?.archive_bottom_percent ?? 20,
      consolidationThreshold: parsed.memory?.consolidation_threshold ?? 5,
    },
    antiPattern: {
      enabled: parsed.anti_pattern?.enabled ?? true,
      detectionModel: parsed.anti_pattern?.detection_model ?? DEFAULT_SYSTEM_MODEL,
      startAfterTurn: parsed.anti_pattern?.start_after_turn ?? 3,
      detectEveryNTurns: parsed.anti_pattern?.detect_every_n_turns ?? 2,
    },
    participation: {
      maxAgentsPerTurn: parsed.participation?.max_agents_per_turn ?? 3,
      minAgentsPerTurn: parsed.participation?.min_agents_per_turn ?? 2,
      recruitmentMessage: parsed.participation?.recruitment_message ?? true,
      listenerAgent: parsed.participation?.listener_agent ?? '',
    },
    execution: parsed.execution ? {
      enabled: parsed.execution.enabled ?? false,
      maxConcurrentWorktrees: parsed.execution.max_concurrent_worktrees ?? 3,
      executorTimeoutMs: parsed.execution.executor_timeout_ms ?? 300000,
      autoDispatch: parsed.execution.auto_dispatch ?? true,
      repoPath: parsed.execution.repo_path ?? '.',
    } : undefined,
    systemModels: {
      intentClassification: parsed.system_models?.intent_classification ?? DEFAULT_SYSTEM_MODEL,
      taskDecomposition: parsed.system_models?.task_decomposition ?? DEFAULT_SYSTEM_MODEL,
    },
  };
}
