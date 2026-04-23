export type AgentRole =
  | 'advocate'
  | 'critic'
  | 'analyst'
  | 'synthesizer'
  | 'author'
  | 'reviewer'
  | 'sneaky-prover'
  | 'biased-prover'
  | 'deceptive-prover'
  | 'calibrated-prover';

export type IntentType = 'deliberation' | 'quick-answer' | 'implementation' | 'investigation' | 'meta';
export type Complexity = 'low' | 'medium' | 'high';

export type AgentTier = Complexity | 'unknown';

export interface BlindReviewSessionRow {
  sessionId: string;
  threadId: number;
  topic: string | null;
  agentIds: string[];
  startedAt: string;
  revealedAt: string | null;
}

export interface BlindReviewEventInput {
  sessionId: string;
  agentId: string;
  tier: AgentTier;
  model: string;
  score: number;
  feedbackText?: string;
}

export interface AgentTierStats {
  agentId: string;
  tier: AgentTier;
  sampleCount: number;
  avgScore: number;
  last5Scores: number[];
  updatedAt: string;
}

export type FacilitatorAction = 'steer' | 'challenge' | 'summarize' | 'escalate' | 'structure' | 'end';
export type DebateStructure = 'free' | 'structured' | 'round-robin';
export type ResponseClassification = 'opposition' | 'conditional' | 'agreement';

export interface CouncilMessage {
  id: string;
  role: 'human' | 'agent' | 'human-critique';
  agentId?: string;
  content: string;
  timestamp: number;
  replyTo?: string;
  threadId?: number;
  metadata?: {
    assignedRole?: AgentRole;
    confidence?: number;
    references?: string[];
  };
  stressTest?: boolean;
  blindReview?: boolean;
  adversarialMode?: import('./council/adversarial-provers.js').AdversarialMode;
  pvgRotate?: boolean;
  // Present only when role === 'human-critique'. Populated by
  // src/council/human-critique.ts makeHumanCritique factory.
  critiqueStance?: import('./council/human-critique.js').HumanCritiqueStance;
  critiqueTarget?: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  provider: string;
  model: string;
  memoryDir: string;
  personality: string;
  botTokenEnv?: string;
  topics?: string[];
  roleType?: 'peer' | 'facilitator';
  models?: { low: string; medium: string; high: string };
  defaultModelTier?: Complexity;
  // Per-tier thinking config. Omit `thinking` entirely to let the SDK default
  // (no thinking parameter sent — model reasons internally without thinking blocks).
  thinking?: Partial<Record<Complexity,
    | { mode: 'adaptive' }
    | { mode: 'enabled'; budget_tokens: number }
  >>;
  cacheSystemPrompt?: boolean;
}

export interface CouncilConfig {
  gateway: {
    thinkingWindowMs: number;
    randomDelayMs: [number, number];
    maxInterAgentRounds: number;
    contextWindowTurns: number;
    sessionMaxTurns: number;
  };
  antiSycophancy: {
    disagreementThreshold: number;
    consecutiveLowRounds: number;
    challengeAngles: string[];
  };
  roles: {
    default2Agents: AgentRole[];
    topicOverrides: Record<string, AgentRole[]>;
  };
  memory?: MemoryConfig;
  antiPattern?: AntiPatternConfig;
  participation?: ParticipationConfig;
  execution?: ExecutionConfig;
  systemModels: SystemModelsConfig;
}

export interface SystemModelsConfig {
  intentClassification: string;
  taskDecomposition: string;
}

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type ThinkingConfig =
  | { type: 'enabled'; budget_tokens: number }  // fixed budget (older models).
  | { type: 'adaptive' };                        // Opus 4.7+: model decides.

export interface SystemPromptPart {
  text: string;
  cache?: boolean;
}

export interface ChatOptions {
  model: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt: string;
  systemPromptParts?: SystemPromptPart[];
  thinking?: ThinkingConfig;
}

export interface ProviderResponse {
  content: string;
  thinking?: string;
  skip?: boolean;
  skipReason?: string;
  confidence?: number;
  references?: string[];
  tokensUsed: { input: number; output: number };
  tierUsed?: AgentTier;
  modelUsed?: string;
}

export interface LLMProvider {
  readonly name: string;
  chat(messages: ProviderMessage[], options: ChatOptions): Promise<ProviderResponse>;
  summarize(text: string, model: string): Promise<string>;
  estimateTokens(messages: ProviderMessage[]): number;
}

export interface AgentStats {
  responseCount: number;
  disagreementRate: number;
  averageLength: number;
  skipCount: number;
  modelUsage: Record<string, { calls: number; inputTokens: number; outputTokens: number }>;
}

export interface SessionSummary {
  name: string;
  type: 'council-session';
  confidence: number;
  participants: string[];
  outcome: 'decision' | 'open' | 'deferred';
  usageCount: number;
  lastUsed: string;
  conclusion: string;
  perspectives: Record<string, string>;
  unresolvedDisagreements: string;
}

export interface MemoryRecord {
  id: string;
  agentId: string;
  type: 'session' | 'principle' | 'rule' | 'archive';
  topic: string | null;
  confidence: number;
  outcome: 'decision' | 'open' | 'deferred' | null;
  usageCount: number;
  lastUsed: string | null;
  createdAt: string;
  contentPreview: string;
}

export interface PatternRecord {
  id: number;
  agentId: string;
  topic: string;
  behavior: string;
  extractedFrom: string;
  createdAt: string;
}

export type PatternType = 'mirror' | 'fake_dissent' | 'quick_surrender' | 'authority_submission';

export interface MemoryConfig {
  dbPath: string;
  sessionTimeoutMs: number;
  endKeywords: string[];
  archiveThreshold: number;
  archiveBottomPercent: number;
  consolidationThreshold: number;
}

export interface AntiPatternConfig {
  enabled: boolean;
  detectionModel: string;
  startAfterTurn: number;
  detectEveryNTurns: number;
}

export interface ParticipationConfig {
  maxAgentsPerTurn: number;
  minAgentsPerTurn: number;
  recruitmentMessage: boolean;
  listenerAgent: string;
}

export interface ExecutionConfig {
  enabled: boolean;
  maxConcurrentWorktrees: number;
  executorTimeoutMs: number;
  autoDispatch: boolean;
  repoPath: string;
}

export interface ExecutionTask {
  id: string;
  description: string;
  assignedAgent: string;
  worktreePath: string;
  branch: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: { diff: string; filesChanged: string[]; commitHash: string };
  error?: string;
}

export interface HistorySegment {
  startedAt: string;
  endedAt: string | null;
  // External readers see this as readonly so mutation only flows through
  // DeliberationHandler's public lifecycle methods. The handler casts
  // internally when it needs to push.
  messages: readonly CouncilMessage[];
  snapshotId: string | null;
}

export interface ResetSnapshotMetadata {
  openQuestionsCount: number;
  decisionsCount: number;
  blindReviewSessionId: string | null;
}

export interface ResetSnapshot {
  snapshotId: string;
  threadId: number;
  segmentIndex: number;
  sealedAt: string;
  summaryMarkdown: string;
  metadata: ResetSnapshotMetadata;
}
