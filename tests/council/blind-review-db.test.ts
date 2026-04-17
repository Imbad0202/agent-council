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

describe('BlindReviewDB stats', () => {
  function seed(db: BlindReviewDB, agentId: string, tier: AgentTier, scores: number[]) {
    const sid = `s-${Date.now()}-${Math.random()}`;
    db.recordSession({ sessionId: sid, threadId: 1, topic: null, agentIds: [agentId], startedAt: 'now', revealedAt: null });
    for (const s of scores) {
      db.recordScore({ sessionId: sid, agentId, tier, model: 'm', score: s });
    }
    db.refreshStats(agentId, tier);
  }

  it('getStats returns zero stats when no events', () => {
    const db = new BlindReviewDB(':memory:');
    expect(db.getStats('nobody', 'high')).toMatchObject({
      agentId: 'nobody',
      tier: 'high',
      sampleCount: 0,
      avgScore: 0,
      last5Scores: [],
    });
  });

  it('refreshStats aggregates events for (agent, tier)', () => {
    const db = new BlindReviewDB(':memory:');
    seed(db, 'a1', 'high', [5, 4, 3]);
    const stats = db.getStats('a1', 'high');
    expect(stats.sampleCount).toBe(3);
    expect(stats.avgScore).toBeCloseTo(4.0, 5);
    expect(stats.last5Scores).toEqual([5, 4, 3]);
  });

  it('last5Scores keeps only the most recent 5 in insertion order', () => {
    const db = new BlindReviewDB(':memory:');
    seed(db, 'a1', 'low', [1, 2, 3, 4, 5, 6, 7]);
    const stats = db.getStats('a1', 'low');
    expect(stats.last5Scores).toEqual([3, 4, 5, 6, 7]);
    expect(stats.sampleCount).toBe(7);
  });

  it('refreshStats skips events where tier is unknown', () => {
    const db = new BlindReviewDB(':memory:');
    db.recordSession({ sessionId: 's1', threadId: 1, topic: null, agentIds: ['a'], startedAt: 'now', revealedAt: null });
    db.recordScore({ sessionId: 's1', agentId: 'a', tier: 'unknown', model: 'm', score: 5 });
    db.recordScore({ sessionId: 's1', agentId: 'a', tier: 'high', model: 'm', score: 3 });
    db.refreshStats('a', 'high');
    db.refreshStats('a', 'unknown');
    expect(db.getStats('a', 'unknown').sampleCount).toBe(0);
    expect(db.getStats('a', 'high').sampleCount).toBe(1);
  });
});
