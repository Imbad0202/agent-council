import { EventEmitter } from 'node:events';
import type {
  CouncilMessage,
  AgentRole,
  IntentType,
  Complexity,
  FacilitatorAction,
  DebateStructure,
  PatternType,
  ProviderResponse,
  ExecutionTask,
  ResponseClassification,
} from '../types.js';

export interface EventMap {
  'message.received': { message: CouncilMessage; threadId: number };
  'intent.classified': { intent: IntentType; complexity: Complexity; threadId: number; message: CouncilMessage };
  'deliberation.started': { threadId: number; participants: string[]; roles: Record<string, AgentRole>; structure: DebateStructure };
  'memory.injected': { threadId: number; agentId: string; memories: string[] };
  'agent.responding': { threadId: number; agentId: string; role: AgentRole };
  'agent.responded': { threadId: number; agentId: string; response: ProviderResponse; role: AgentRole; classification: ResponseClassification };
  'pattern.detected': { threadId: number; pattern: PatternType; targetAgent: string };
  'convergence.detected': { threadId: number; angle: string };
  'facilitator.intervened': { threadId: number; action: FacilitatorAction; content: string; targetAgent?: string };
  'deliberation.ended': { threadId: number; conclusion: string; intent: IntentType };
  'execution.dispatched': { threadId: number; tasks: ExecutionTask[] };
  'execution.completed': { threadId: number; tasks: ExecutionTask[]; diffs: string[] };
  'session.ending': { threadId: number; trigger: 'keyword' | 'timeout' | 'max_turns' };
  'session.ended': { threadId: number; topic: string; outcome: string };
  'blind-review.started': { threadId: number; codes: string[] };
  'blind-review.scored': { threadId: number; code: string; score: number; allScored: boolean };
  'blind-review.revealed': { threadId: number };
  'blind-review.persist-failed': { threadId: number; sessionId: string; error: Error };
  'pvg-rotate.persist-failed': { threadId: number; error: Error };
  'pvg-rotate.revealed': { threadId: number; correct: boolean };
}

export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    this.emitter.emit(event, payload);
  }

  on<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void | Promise<void>): void {
    this.emitter.on(event, handler as (...args: unknown[]) => void);
  }

  once<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void | Promise<void>): void {
    this.emitter.once(event, handler as (...args: unknown[]) => void);
  }

  off<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void | Promise<void>): void {
    this.emitter.off(event, handler as (...args: unknown[]) => void);
  }
}
