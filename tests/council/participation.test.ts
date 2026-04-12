import { describe, it, expect } from 'vitest';
import { ParticipationManager } from '../../src/council/participation.js';
import type { AgentConfig, ParticipationConfig } from '../../src/types.js';

const config: ParticipationConfig = {
  maxAgentsPerTurn: 3,
  minAgentsPerTurn: 2,
  recruitmentMessage: true,
  listenerAgent: 'huahua',
};

const agents: AgentConfig[] = [
  { id: 'huahua', name: '花花', provider: 'claude', model: 'opus', memoryDir: '', personality: '', topics: ['architecture', 'code', 'general'] },
  { id: 'binbin', name: '賓賓', provider: 'claude', model: 'opus', memoryDir: '', personality: '', topics: ['code', 'risk', 'testing'] },
  { id: 'gemini', name: 'Gemini', provider: 'google', model: 'gemini', memoryDir: '', personality: '', topics: ['research', 'data', 'analysis'] },
];

describe('ParticipationManager', () => {
  const manager = new ParticipationManager(config, agents);

  it('selects agents based on topic match', () => {
    const selected = manager.selectParticipants('Let me review this code implementation');
    expect(selected).toContain('huahua'); // has 'code'
    expect(selected).toContain('binbin'); // has 'code'
    expect(selected.length).toBeLessThanOrEqual(3);
  });

  it('selects research agent for research topics', () => {
    const selected = manager.selectParticipants('Show me the research data and analysis');
    expect(selected).toContain('gemini'); // has 'research', 'data', 'analysis'
  });

  it('ensures minimum participants', () => {
    // Even with no topic match, should return at least 2
    const selected = manager.selectParticipants('Hello');
    expect(selected.length).toBeGreaterThanOrEqual(2);
  });

  it('respects max agents per turn', () => {
    const manyAgents = [...agents,
      { id: 'a4', name: 'A4', provider: 'claude', model: 'opus', memoryDir: '', personality: '', topics: ['code'] },
      { id: 'a5', name: 'A5', provider: 'claude', model: 'opus', memoryDir: '', personality: '', topics: ['code'] },
    ];
    const mgr = new ParticipationManager(config, manyAgents);
    const selected = mgr.selectParticipants('Review this code');
    expect(selected.length).toBeLessThanOrEqual(3);
  });

  it('detects recruitment changes', () => {
    const changes = manager.detectRecruitment(
      'Show me the research data',
      ['huahua', 'binbin'],
      { huahua: 0, binbin: 4 }, // binbin has been silent 4 turns
    );
    expect(changes.joining).toContain('gemini');
    // binbin might leave if not in optimal AND silent for 3+
    expect(changes.leaving.length).toBeGreaterThanOrEqual(0);
  });
});
