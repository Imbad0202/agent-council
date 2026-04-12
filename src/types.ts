export type AgentRole = 'advocate' | 'critic' | 'analyst' | 'synthesizer' | 'author' | 'reviewer';

export interface CouncilMessage {
  id: string;
  role: 'human' | 'agent';
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
}

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt: string;
}

export interface ProviderResponse {
  content: string;
  skip?: boolean;
  skipReason?: string;
  confidence?: number;
  references?: string[];
  tokensUsed: { input: number; output: number };
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
  type: 'session' | 'principle' | 'archive';
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
