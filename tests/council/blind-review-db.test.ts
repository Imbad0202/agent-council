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
