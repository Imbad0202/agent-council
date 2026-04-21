import { describe, it, expect } from 'vitest';
import type { CouncilMessage } from '../../src/types.js';
import {
  makeHumanCritique,
  isHumanCritique,
  type HumanCritiqueStance,
} from '../../src/council/human-critique.js';

describe('human-critique message type', () => {
  it('makeHumanCritique builds a valid CouncilMessage with role human-critique', () => {
    const msg = makeHumanCritique({
      content: 'You both ignored the cost axis.',
      stance: 'challenge',
      targetAgent: 'huahua',
      threadId: 1,
    });
    expect(msg.role).toBe('human-critique');
    expect(msg.critiqueStance).toBe('challenge');
    expect(msg.critiqueTarget).toBe('huahua');
    expect(msg.threadId).toBe(1);
    expect(msg.id).toMatch(/^critique-/);
    expect(msg.timestamp).toBeGreaterThan(0);
  });

  it('isHumanCritique narrows CouncilMessage correctly', () => {
    const critique = makeHumanCritique({ content: 'x', stance: 'question' });
    const human: CouncilMessage = {
      id: 'm-1',
      role: 'human',
      content: 'hi',
      timestamp: 1,
    };
    const agent: CouncilMessage = {
      id: 'm-2',
      role: 'agent',
      agentId: 'a',
      content: 'hi',
      timestamp: 2,
    };
    expect(isHumanCritique(critique)).toBe(true);
    expect(isHumanCritique(human)).toBe(false);
    expect(isHumanCritique(agent)).toBe(false);
  });

  it('all three stances are representable', () => {
    const q = makeHumanCritique({ content: 'q', stance: 'question' });
    const c = makeHumanCritique({ content: 'c', stance: 'challenge' });
    const p = makeHumanCritique({ content: 'p', stance: 'addPremise' });
    const stances: HumanCritiqueStance[] = [q.critiqueStance!, c.critiqueStance!, p.critiqueStance!];
    expect(new Set(stances).size).toBe(3);
  });

  it('older human/agent messages still typecheck without critique fields', () => {
    const human: CouncilMessage = {
      id: 'm-1',
      role: 'human',
      content: 'hello',
      timestamp: 1,
    };
    expect(human.critiqueStance).toBeUndefined();
    expect(human.critiqueTarget).toBeUndefined();
  });
});
