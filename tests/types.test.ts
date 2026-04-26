import { describe, it, expect } from 'vitest';
import { effectiveRoleType } from '../src/types.js';
import type {
  AgentRole,
  CouncilMessage,
  AgentConfig,
  CouncilConfig,
  ProviderResponse,
  MemoryRecord,
  PatternRecord,
  ParticipationConfig,
  IntentType,
  Complexity,
  FacilitatorAction,
  DebateStructure,
  ResponseClassification,
  AgentStats,
  ExecutionConfig,
  ExecutionTask,
  WorkerRoleType,
} from '../src/types.js';

describe('types', () => {
  it('CouncilMessage can represent a human message', () => {
    const msg: CouncilMessage = {
      id: 'msg-1',
      role: 'human',
      content: 'What do you think about monorepos?',
      timestamp: Date.now(),
    };
    expect(msg.role).toBe('human');
    expect(msg.agentId).toBeUndefined();
  });

  it('CouncilMessage can represent an agent message with metadata', () => {
    const msg: CouncilMessage = {
      id: 'msg-2',
      role: 'agent',
      agentId: 'huahua',
      content: 'I think monorepos are better because...',
      timestamp: Date.now(),
      replyTo: 'msg-1',
      metadata: {
        assignedRole: 'advocate',
        confidence: 0.85,
        references: ['project_ars_optimization.md'],
      },
    };
    expect(msg.role).toBe('agent');
    expect(msg.metadata?.assignedRole).toBe('advocate');
  });

  it('ProviderResponse can indicate skip', () => {
    const response: ProviderResponse = {
      content: '',
      skip: true,
      skipReason: 'no new perspective',
      confidence: 0,
      references: [],
      tokensUsed: { input: 0, output: 0 },
    };
    expect(response.skip).toBe(true);
  });

  it('MemoryRecord has required fields', () => {
    const record: MemoryRecord = {
      id: 'huahua/sessions/council-session-2026-04-12-monorepo.md',
      agentId: 'huahua',
      type: 'session',
      topic: 'monorepo',
      confidence: 0.8,
      outcome: 'decision',
      usageCount: 3,
      lastUsed: '2026-04-12',
      createdAt: '2026-04-12',
      contentPreview: 'Decided to use monorepo because...',
    };
    expect(record.type).toBe('session');
    expect(record.usageCount).toBe(3);
  });

  it('PatternRecord has required fields', () => {
    const pattern: PatternRecord = {
      id: 1,
      agentId: 'huahua',
      topic: 'architecture',
      behavior: 'tends toward conservative positions',
      extractedFrom: 'principle-architecture.md',
      createdAt: '2026-04-12',
    };
    expect(pattern.behavior).toContain('conservative');
  });

  it('AgentConfig supports botTokenEnv and topics', () => {
    const config: AgentConfig = {
      id: 'test',
      name: 'Test',
      provider: 'claude',
      model: 'claude-opus-4-7',
      memoryDir: 'test/global',
      personality: 'You are test.',
      botTokenEnv: 'TELEGRAM_BOT_TOKEN_TEST',
      topics: ['code', 'architecture'],
    };
    expect(config.botTokenEnv).toBe('TELEGRAM_BOT_TOKEN_TEST');
    expect(config.topics).toContain('code');
  });

  it('CouncilMessage supports threadId', () => {
    const msg: CouncilMessage = {
      id: 'msg-1',
      role: 'human',
      content: 'test',
      timestamp: Date.now(),
      threadId: 12345,
    };
    expect(msg.threadId).toBe(12345);
  });

  it('IntentType covers all expected values', () => {
    const values: IntentType[] = ['deliberation', 'quick-answer', 'implementation', 'investigation', 'meta'];
    expect(values).toHaveLength(5);
    expect(values).toContain('deliberation');
    expect(values).toContain('quick-answer');
    expect(values).toContain('implementation');
    expect(values).toContain('investigation');
    expect(values).toContain('meta');
  });

  it('Complexity covers all expected values', () => {
    const values: Complexity[] = ['low', 'medium', 'high'];
    expect(values).toHaveLength(3);
  });

  it('FacilitatorAction covers all expected values', () => {
    const values: FacilitatorAction[] = ['steer', 'challenge', 'summarize', 'escalate', 'structure', 'end'];
    expect(values).toHaveLength(6);
  });

  it('DebateStructure covers all expected values', () => {
    const values: DebateStructure[] = ['free', 'structured', 'round-robin'];
    expect(values).toHaveLength(3);
  });

  it('ResponseClassification covers all expected values', () => {
    const values: ResponseClassification[] = ['opposition', 'conditional', 'agreement'];
    expect(values).toHaveLength(3);
  });

  it('AgentConfig supports optional roleType, models, and defaultModelTier', () => {
    const config: AgentConfig = {
      id: 'facilitator-1',
      name: 'Facilitator',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      memoryDir: 'test/global',
      personality: 'You facilitate.',
      roleType: 'facilitator',
      models: { low: 'claude-sonnet-4-6', medium: 'claude-sonnet-4-6', high: 'claude-opus-4-7' },
      defaultModelTier: 'medium',
    };
    expect(config.roleType).toBe('facilitator');
    expect(config.models?.low).toBe('claude-sonnet-4-6');
    expect(config.defaultModelTier).toBe('medium');
  });

  it('AgentConfig without roleType/models/defaultModelTier still works (backwards compat)', () => {
    const config: AgentConfig = {
      id: 'test',
      name: 'Test',
      provider: 'claude',
      model: 'claude-opus-4-7',
      memoryDir: 'test/global',
      personality: 'You are test.',
    };
    expect(config.roleType).toBeUndefined();
    expect(config.models).toBeUndefined();
    expect(config.defaultModelTier).toBeUndefined();
  });

  it('MemoryRecord type accepts "rule"', () => {
    const record: MemoryRecord = {
      id: 'huahua/rules/rule-1.md',
      agentId: 'huahua',
      type: 'rule',
      topic: null,
      confidence: 1,
      outcome: null,
      usageCount: 0,
      lastUsed: null,
      createdAt: '2026-04-13',
      contentPreview: 'Always verify sources.',
    };
    expect(record.type).toBe('rule');
  });

  it('AgentStats includes modelUsage', () => {
    const stats: AgentStats = {
      responseCount: 5,
      disagreementRate: 0.2,
      averageLength: 300,
      skipCount: 1,
      modelUsage: {
        'claude-sonnet-4-6': { calls: 4, inputTokens: 1000, outputTokens: 500 },
        'claude-opus-4-7': { calls: 1, inputTokens: 200, outputTokens: 100 },
      },
    };
    expect(stats.modelUsage['claude-sonnet-4-6'].calls).toBe(4);
    expect(stats.modelUsage['claude-opus-4-7'].outputTokens).toBe(100);
  });

  it('ExecutionConfig has required fields', () => {
    const config: ExecutionConfig = {
      enabled: true,
      maxConcurrentWorktrees: 3,
      executorTimeoutMs: 60000,
      autoDispatch: false,
      repoPath: '/Users/imbad/Projects/agent-council',
    };
    expect(config.enabled).toBe(true);
    expect(config.maxConcurrentWorktrees).toBe(3);
  });

  it('ExecutionTask has required fields and optional result/error', () => {
    const task: ExecutionTask = {
      id: 'task-1',
      description: 'Refactor gateway module',
      assignedAgent: 'huahua',
      worktreePath: '/tmp/worktrees/task-1',
      branch: 'task/refactor-gateway',
      status: 'completed',
      result: {
        diff: '+added line\n-removed line',
        filesChanged: ['src/gateway.ts'],
        commitHash: 'abc1234',
      },
    };
    expect(task.status).toBe('completed');
    expect(task.result?.filesChanged).toContain('src/gateway.ts');
    expect(task.error).toBeUndefined();
  });

  it('ExecutionTask with status pending has no result', () => {
    const task: ExecutionTask = {
      id: 'task-2',
      description: 'Write tests',
      assignedAgent: 'weiyi',
      worktreePath: '/tmp/worktrees/task-2',
      branch: 'task/write-tests',
      status: 'pending',
    };
    expect(task.status).toBe('pending');
    expect(task.result).toBeUndefined();
  });

  it('CouncilConfig supports optional execution field', () => {
    const config: CouncilConfig = {
      gateway: {
        thinkingWindowMs: 1000,
        randomDelayMs: [500, 1500],
        maxInterAgentRounds: 3,
        contextWindowTurns: 10,
        sessionMaxTurns: 20,
      },
      antiSycophancy: {
        disagreementThreshold: 0.3,
        consecutiveLowRounds: 2,
        challengeAngles: ['alternative', 'risk'],
      },
      roles: {
        default2Agents: ['advocate', 'critic'],
        topicOverrides: {},
      },
      execution: {
        enabled: true,
        maxConcurrentWorktrees: 2,
        executorTimeoutMs: 30000,
        autoDispatch: false,
        repoPath: '/Users/imbad/Projects/agent-council',
      },
    };
    expect(config.execution?.enabled).toBe(true);
  });
});

describe('effectiveRoleType', () => {
  const baseConfig: AgentConfig = {
    id: 'a', name: 'A', provider: 'custom', model: 'm',
    memoryDir: '.', personality: '',
  };

  it('returns explicit roleType when set', () => {
    const r: WorkerRoleType = effectiveRoleType({ ...baseConfig, roleType: 'facilitator' });
    expect(r).toBe('facilitator');
    expect(effectiveRoleType({ ...baseConfig, roleType: 'artifact-synthesizer' })).toBe('artifact-synthesizer');
    expect(effectiveRoleType({ ...baseConfig, roleType: 'peer' })).toBe('peer');
  });

  it('defaults undefined roleType to peer', () => {
    expect(effectiveRoleType(baseConfig)).toBe('peer');
  });
});
