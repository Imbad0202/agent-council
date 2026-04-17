import { describe, it, expect } from 'vitest';
import { BlindReviewDB } from '../../src/council/blind-review-db.js';

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
