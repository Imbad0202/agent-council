import { describe, it, expect } from 'vitest';
import { BlindReviewDB } from '../../src/council/blind-review-db.js';
import type { BlindReviewSessionRow, BlindReviewEventInput, AgentTier } from '../../src/types.js';

describe('BlindReviewDB constructor', () => {
  it('creates a DB and migrates schema with 3 tables', () => {
    const db = new BlindReviewDB(':memory:');
    const tables = db.listTables();
    expect(tables).toContain('blind_review_sessions');
    expect(tables).toContain('blind_review_events');
    expect(tables).toContain('blind_review_stats');
  });

  it('is idempotent across re-instantiation', () => {
    const db1 = new BlindReviewDB(':memory:');
    expect(() => new BlindReviewDB(':memory:')).not.toThrow();
    db1.close();
  });
});

describe('BlindReview types', () => {
  it('AgentTier accepts low/medium/high/unknown', () => {
    const tiers: AgentTier[] = ['low', 'medium', 'high', 'unknown'];
    expect(tiers).toHaveLength(4);
  });

  it('BlindReviewEventInput has required fields', () => {
    const input: BlindReviewEventInput = {
      sessionId: 's1',
      agentId: 'a1',
      tier: 'high',
      model: 'claude-opus-4-7',
      score: 4,
    };
    expect(input.feedbackText).toBeUndefined();
  });
});

describe('BlindReviewDB writes', () => {
  it('recordSession inserts a session row', () => {
    const db = new BlindReviewDB(':memory:');
    db.recordSession({
      sessionId: 't1:1000',
      threadId: 1,
      topic: 'monorepo',
      agentIds: ['huahua', 'binbin'],
      startedAt: '2026-04-17T00:00:00Z',
      revealedAt: '2026-04-17T00:05:00Z',
    });
    expect(db.getSession('t1:1000')).toMatchObject({
      sessionId: 't1:1000',
      threadId: 1,
      topic: 'monorepo',
      agentIds: ['huahua', 'binbin'],
    });
  });

  it('recordScore inserts an event row', () => {
    const db = new BlindReviewDB(':memory:');
    db.recordSession({
      sessionId: 's1', threadId: 1, topic: null,
      agentIds: ['a1'], startedAt: 'now', revealedAt: null,
    });
    db.recordScore({
      sessionId: 's1', agentId: 'a1', tier: 'high',
      model: 'claude-opus-4-7', score: 4,
    });
    const events = db.getEventsForSession('s1');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ agentId: 'a1', tier: 'high', score: 4 });
  });

  it('recordScore stores feedbackText when provided', () => {
    const db = new BlindReviewDB(':memory:');
    db.recordSession({ sessionId: 's1', threadId: 1, topic: null, agentIds: ['a'], startedAt: 'now', revealedAt: null });
    db.recordScore({ sessionId: 's1', agentId: 'a', tier: 'low', model: 'haiku', score: 3, feedbackText: 'good' });
    expect(db.getEventsForSession('s1')[0].feedbackText).toBe('good');
  });
});
