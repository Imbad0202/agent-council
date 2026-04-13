import { describe, it, expect } from 'vitest';
import { deriveEmotion, deriveStanceShift, buildRichMetadata } from '../../src/adapters/metadata.js';
import type { AgentConfig } from '../../src/types.js';

const agents: AgentConfig[] = [
  {
    id: 'agent-1',
    name: 'Advocate',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    memoryDir: '/tmp',
    personality: 'advocate',
  },
  {
    id: 'agent-2',
    name: 'Critic',
    provider: 'openai',
    model: 'gpt-4o',
    memoryDir: '/tmp',
    personality: 'critic',
  },
];

describe('deriveEmotion', () => {
  it('returns assertive for opposition', () => {
    expect(deriveEmotion('opposition')).toBe('assertive');
  });

  it('returns thoughtful for conditional', () => {
    expect(deriveEmotion('conditional')).toBe('thoughtful');
  });

  it('returns neutral for agreement', () => {
    expect(deriveEmotion('agreement')).toBe('neutral');
  });

  it('returns neutral for undefined', () => {
    expect(deriveEmotion(undefined)).toBe('neutral');
  });
});

describe('deriveStanceShift', () => {
  it('returns softened when opposition changes to agreement', () => {
    expect(deriveStanceShift('agreement', 'opposition')).toBe('softened');
  });

  it('returns hardened when agreement changes to opposition', () => {
    expect(deriveStanceShift('opposition', 'agreement')).toBe('hardened');
  });

  it('returns unchanged when classification is the same', () => {
    expect(deriveStanceShift('opposition', 'opposition')).toBe('unchanged');
    expect(deriveStanceShift('agreement', 'agreement')).toBe('unchanged');
    expect(deriveStanceShift('conditional', 'conditional')).toBe('unchanged');
  });

  it('returns unchanged when there is no previous classification', () => {
    expect(deriveStanceShift('opposition', undefined)).toBe('unchanged');
    expect(deriveStanceShift(undefined, undefined)).toBe('unchanged');
  });

  it('returns unchanged when current is undefined but previous exists', () => {
    expect(deriveStanceShift(undefined, 'opposition')).toBe('unchanged');
  });

  it('returns unchanged for other combinations (e.g. conditional→opposition)', () => {
    expect(deriveStanceShift('opposition', 'conditional')).toBe('unchanged');
    expect(deriveStanceShift('conditional', 'agreement')).toBe('unchanged');
  });
});

describe('buildRichMetadata', () => {
  it('looks up agent name from agents array', () => {
    const meta = buildRichMetadata('agent-1', agents);
    expect(meta.agentName).toBe('Advocate');
  });

  it('falls back to agentId when agent not found', () => {
    const meta = buildRichMetadata('unknown-agent', agents);
    expect(meta.agentName).toBe('unknown-agent');
  });

  it('detects system agent correctly', () => {
    const meta = buildRichMetadata('system', agents);
    expect(meta.isSystem).toBe(true);
  });

  it('isSystem is false for non-system agents', () => {
    const meta = buildRichMetadata('agent-1', agents);
    expect(meta.isSystem).toBe(false);
  });

  it('includes role when provided', () => {
    const meta = buildRichMetadata('agent-1', agents, undefined, undefined, 'critic');
    expect(meta.role).toBe('critic');
  });

  it('role is undefined when not provided', () => {
    const meta = buildRichMetadata('agent-1', agents);
    expect(meta.role).toBeUndefined();
  });

  it('derives emotion from classification', () => {
    const meta = buildRichMetadata('agent-1', agents, 'opposition');
    expect(meta.emotion).toBe('assertive');
  });

  it('derives stance shift from previous classification', () => {
    const meta = buildRichMetadata('agent-1', agents, 'agreement', 'opposition');
    expect(meta.stanceShift).toBe('softened');
  });

  it('derives unchanged stance shift when no previous', () => {
    const meta = buildRichMetadata('agent-1', agents, 'opposition');
    expect(meta.stanceShift).toBe('unchanged');
  });

  it('includes correct agent name for agent-2', () => {
    const meta = buildRichMetadata('agent-2', agents, 'conditional', undefined, 'analyst');
    expect(meta.agentName).toBe('Critic');
    expect(meta.emotion).toBe('thoughtful');
    expect(meta.role).toBe('analyst');
  });
});
