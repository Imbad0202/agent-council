// tests/council/blind-review.test.ts
import { describe, it, expect } from 'vitest';
import {
  BlindReviewStore,
  assignCodes,
  formatRevealMessage,
  type BlindReviewSession,
} from '../../src/council/blind-review.js';

describe('blind-review module', () => {
  it('assignCodes is deterministic and sorted by agentId', () => {
    const result = assignCodes(['zeta-bot', 'alpha-bot']);
    expect(result.get('Agent-A')).toBe('alpha-bot');
    expect(result.get('Agent-B')).toBe('zeta-bot');
    expect([...result.keys()]).toEqual(['Agent-A', 'Agent-B']);
  });

  it('BlindReviewStore.create + get round-trip', () => {
    const store = new BlindReviewStore();
    const roles = new Map<string, string>([
      ['alpha-bot', 'critic'],
      ['zeta-bot', 'advocate'],
    ]);
    const session = store.create(1, ['alpha-bot', 'zeta-bot'], roles);
    expect(session).not.toHaveProperty('error');
    const got = store.get(1);
    expect(got?.codeToAgentId.get('Agent-A')).toBe('alpha-bot');
    expect(got?.agentIdToRole.get('zeta-bot')).toBe('advocate');
    expect(got?.scores.size).toBe(0);
    expect(got?.revealed).toBe(false);
  });

  it('recordScore returns allScored=false until all coded', () => {
    const store = new BlindReviewStore();
    store.create(2, ['a', 'b'], new Map([['a', 'critic'], ['b', 'advocate']]));
    expect(store.recordScore(2, 'Agent-A', 4)).toEqual({ allScored: false });
    expect(store.recordScore(2, 'Agent-B', 5)).toEqual({ allScored: true });
  });

  it('recordScore for unknown code returns error', () => {
    const store = new BlindReviewStore();
    store.create(3, ['a'], new Map([['a', 'critic']]));
    const result = store.recordScore(3, 'Agent-Z', 4);
    expect(result).toHaveProperty('error');
  });

  it('recordScore on already-revealed session returns error', () => {
    const store = new BlindReviewStore();
    store.create(4, ['a'], new Map([['a', 'critic']]));
    store.markRevealed(4);
    const result = store.recordScore(4, 'Agent-A', 5);
    expect(result).toHaveProperty('error');
  });

  it('create rejects when a pending session already exists for the thread', () => {
    const store = new BlindReviewStore();
    const first = store.create(5, ['a'], new Map([['a', 'critic']]));
    expect(first).not.toHaveProperty('error');
    const second = store.create(5, ['a'], new Map([['a', 'critic']]));
    expect(second).toHaveProperty('error');
  });

  it('formatRevealMessage prefers session role over agentMeta tbd placeholder', () => {
    const session: BlindReviewSession = {
      threadId: 7,
      startedAt: 0,
      codeToAgentId: new Map([['Agent-A', 'a-id']]),
      agentIdToRole: new Map([['a-id', 'critic']]),  // real per-round role
      scores: new Map([['Agent-A', 4]]),
      revealed: false,
    };
    const meta = new Map([
      ['a-id', { name: 'Claude', role: 'tbd' }],  // placeholder from index.ts
    ]);
    const msg = formatRevealMessage(session, meta);
    expect(msg).toContain('critic');
    expect(msg).not.toContain('tbd');
  });

  it('formatRevealMessage maps codes to names + roles + scores', () => {
    const session: BlindReviewSession = {
      threadId: 6,
      startedAt: 0,
      codeToAgentId: new Map([['Agent-A', 'a-id'], ['Agent-B', 'b-id']]),
      agentIdToRole: new Map([['a-id', 'critic'], ['b-id', 'advocate']]),
      scores: new Map([['Agent-A', 4], ['Agent-B', 5]]),
      revealed: false,
    };
    const meta = new Map([
      ['a-id', { name: 'Claude', role: 'critic' }],
      ['b-id', { name: 'GPT', role: 'advocate' }],
    ]);
    const msg = formatRevealMessage(session, meta);
    expect(msg).toContain('Agent-A');
    expect(msg).toContain('Claude');
    expect(msg).toContain('critic');
    expect(msg).toContain('4');
    expect(msg).toContain('Agent-B');
    expect(msg).toContain('GPT');
    expect(msg).toContain('5');
  });
});
