import type { AgentRole } from '../types.js';

export interface AdapterMessage {
  content: string;
  threadId?: number;
}

export interface RichMetadata {
  agentName: string;
  role?: AgentRole;
  emotion?: 'neutral' | 'assertive' | 'questioning' | 'conceding' | 'thoughtful' | 'frustrated';
  intensity?: number;
  stanceShift?: 'hardened' | 'softened' | 'unchanged';
  replyingTo?: string;
  isSystem?: boolean;
}

export interface InputAdapter {
  start(onMessage: (msg: AdapterMessage) => void): Promise<void>;
  stop(): Promise<void>;
}

export interface OutputAdapter {
  send(agentId: string, content: string, metadata: RichMetadata, threadId?: number): Promise<void>;
  sendSystem(content: string, threadId?: number): Promise<void>;
}

export type Adapter = InputAdapter & OutputAdapter;
