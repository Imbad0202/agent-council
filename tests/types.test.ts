import { describe, it, expect } from 'vitest';
import type {
  AgentRole,
  CouncilMessage,
  AgentConfig,
  CouncilConfig,
  ProviderResponse,
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
});
