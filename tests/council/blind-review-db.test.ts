import { describe, it, expect } from 'vitest';
import { BlindReviewDB } from '../../src/council/blind-review-db.js';
import { buildRecommendation, renderSparkline } from '../../src/council/blind-review-db.js';
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

describe('BlindReviewDB persistSession', () => {
  it('writes session + events + stats atomically', () => {
    const db = new BlindReviewDB(':memory:');
    db.persistSession({
      sessionRow: {
        sessionId: 's1', threadId: 1, topic: 'monorepo',
        agentIds: ['a1', 'a2'], startedAt: 'now', revealedAt: 'now',
      },
      scores: [
        { sessionId: 's1', agentId: 'a1', tier: 'high', model: 'opus', score: 4 },
        { sessionId: 's1', agentId: 'a2', tier: 'low', model: 'haiku', score: 2 },
      ],
    });
    expect(db.getEventsForSession('s1')).toHaveLength(2);
    expect(db.getStats('a1', 'high').sampleCount).toBe(1);
    expect(db.getStats('a2', 'low').sampleCount).toBe(1);
  });

  it('rolls back all writes if one recordScore violates FK', () => {
    const db = new BlindReviewDB(':memory:');
    expect(() => db.persistSession({
      sessionRow: { sessionId: 's2', threadId: 1, topic: null, agentIds: [], startedAt: 'now', revealedAt: 'now' },
      scores: [
        { sessionId: 's2', agentId: 'a1', tier: 'high', model: 'm', score: 4 },
        { sessionId: 'NONEXISTENT', agentId: 'a1', tier: 'high', model: 'm', score: 4 },
      ],
    })).toThrow();
    expect(db.getSession('s2')).toBeNull();
    expect(db.getEventsForSession('s2')).toHaveLength(0);
  });
});

describe('buildRecommendation', () => {
  const base = { agentId: 'huahua', updatedAt: '2026-04-17' };

  it('n<5: 資料累積中', () => {
    expect(buildRecommendation({
      ...base, tier: 'high', sampleCount: 3, avgScore: 4, last5Scores: [4, 4, 4],
    }, { lowerTierModel: null, currentModel: 'opus' }))
      .toBe('資料累積中 (n=3/5)');
  });

  it('n=1: 首次評分', () => {
    expect(buildRecommendation({
      ...base, tier: 'high', sampleCount: 1, avgScore: 5, last5Scores: [5],
    }, { lowerTierModel: null, currentModel: 'opus' }))
      .toBe('首次評分 (n=1/5)');
  });

  it('n>=5 avg>=4: 維持現配置', () => {
    expect(buildRecommendation({
      ...base, tier: 'medium', sampleCount: 5, avgScore: 4.2, last5Scores: [4, 4, 5, 4, 4],
    }, { lowerTierModel: 'haiku', currentModel: 'sonnet' }))
      .toBe('維持現配置');
  });

  it('n>=5 avg 3-4: 表現尚可', () => {
    expect(buildRecommendation({
      ...base, tier: 'low', sampleCount: 5, avgScore: 3.2, last5Scores: [3, 3, 3, 4, 3],
    }, { lowerTierModel: null, currentModel: 'haiku' }))
      .toBe('表現尚可，持續觀察');
  });

  it('n>=5 avg 2-3 tier=high: suggest降到 lower tier', () => {
    expect(buildRecommendation({
      ...base, tier: 'high', sampleCount: 6, avgScore: 2.5, last5Scores: [2, 3, 2, 3, 3],
    }, { lowerTierModel: 'sonnet', currentModel: 'opus' }))
      .toBe('考慮將 huahua 在 high complexity 的 tier 從 opus 降到 sonnet');
  });

  it('n>=5 avg 2-3 tier=medium: suggest降到 low tier', () => {
    expect(buildRecommendation({
      ...base, tier: 'medium', sampleCount: 6, avgScore: 2.2, last5Scores: [2, 2, 3, 2, 2],
    }, { lowerTierModel: 'haiku', currentModel: 'sonnet' }))
      .toBe('考慮將 huahua 在 medium complexity 降到 low tier，或檢視 personality');
  });

  it('n>=5 avg 2-3 tier=low: personality review', () => {
    expect(buildRecommendation({
      ...base, tier: 'low', sampleCount: 6, avgScore: 2.5, last5Scores: [2, 3, 2, 3, 3],
    }, { lowerTierModel: null, currentModel: 'haiku' }))
      .toBe('評分偏低，建議檢視 huahua personality 或 topic 分配');
  });

  it('n>=5 avg<2: 汰換', () => {
    expect(buildRecommendation({
      ...base, tier: 'high', sampleCount: 7, avgScore: 1.5, last5Scores: [1, 2, 1, 2, 2],
    }, { lowerTierModel: 'sonnet', currentModel: 'opus' }))
      .toBe('評分持續過低，建議檢視 personality / topic 或考慮汰換 agent');
  });

  it('n<10 avg extreme: append 初期樣本', () => {
    expect(buildRecommendation({
      ...base, tier: 'medium', sampleCount: 7, avgScore: 4.9, last5Scores: [5, 5, 5, 5, 5],
    }, { lowerTierModel: 'haiku', currentModel: 'sonnet' }))
      .toBe('維持現配置（初期樣本，建議再觀察幾場）');
  });

  it('n=0: 尚無資料', () => {
    expect(buildRecommendation({
      agentId: 'x', tier: 'high', sampleCount: 0, avgScore: 0,
      last5Scores: [], updatedAt: '2026-04-17',
    }, { lowerTierModel: null, currentModel: 'opus' }))
      .toBe('尚無資料');
  });

  it('n>=5 avg 2-3 tier=high with null lowerTierModel falls back to "low tier"', () => {
    expect(buildRecommendation({
      agentId: 'huahua', tier: 'high', sampleCount: 6, avgScore: 2.5,
      last5Scores: [2, 3, 2, 3, 3], updatedAt: '2026-04-17',
    }, { lowerTierModel: null, currentModel: 'opus' }))
      .toBe('考慮將 huahua 在 high complexity 的 tier 從 opus 降到 low tier');
  });
});

describe('renderSparkline', () => {
  it('returns empty string for empty array', () => {
    expect(renderSparkline([])).toBe('');
  });

  it('renders 5 filled stars for [5,5,5,5,5]', () => {
    expect(renderSparkline([5, 5, 5, 5, 5])).toBe('★★★★★');
  });

  it('renders graded fill matching score values', () => {
    const out = renderSparkline([1, 2, 3, 4, 5]);
    expect(out).toHaveLength(5);
    expect(out[0]).toBe('☆');
    expect(out[4]).toBe('★');
  });
});
