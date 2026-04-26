import { describe, it, expect, beforeEach } from 'vitest';
import { ArtifactDB } from '../../src/council/artifact-db.js';
import type { ArtifactInsertInput } from '../../src/council/artifact-db.js';

function makeInput(overrides: Partial<ArtifactInsertInput> = {}): ArtifactInsertInput {
  return {
    thread_id: 1,
    segment_index: 0,
    thread_local_seq: 1,
    preset: 'universal',
    content_md: '# Summary',
    created_at: '2026-04-26T00:00:00Z',
    ...overrides,
  };
}

describe('ArtifactDB: insert + findByThreadPreset', () => {
  let db: ArtifactDB;

  beforeEach(() => {
    db = new ArtifactDB(':memory:');
  });

  it('inserts one row and finds it by thread+preset', () => {
    const row = db.insert(makeInput());
    expect(row.id).toBeGreaterThan(0);
    const found = db.findByThreadPreset(1, 'universal');
    expect(found).not.toBeNull();
    expect(found!.content_md).toBe('# Summary');
    expect(found!.thread_id).toBe(1);
    expect(found!.preset).toBe('universal');
  });

  it('returns null when no row exists for thread+preset', () => {
    expect(db.findByThreadPreset(99, 'universal')).toBeNull();
  });

  it('CRITICAL: returns HIGHEST segment_index row when multiple rows exist for same thread+preset', () => {
    // Insert three rows with mixed segment_index values
    db.insert(makeInput({ segment_index: 2, thread_local_seq: 1, content_md: 'segment 2' }));
    db.insert(makeInput({ segment_index: 0, thread_local_seq: 2, content_md: 'segment 0' }));
    db.insert(makeInput({ segment_index: 5, thread_local_seq: 3, content_md: 'segment 5' }));

    const found = db.findByThreadPreset(1, 'universal');
    expect(found).not.toBeNull();
    // Must return the row with segment_index=5 (highest), not 0 or 2
    expect(found!.segment_index).toBe(5);
    expect(found!.content_md).toBe('segment 5');
  });
});

describe('ArtifactDB: findByThread', () => {
  let db: ArtifactDB;

  beforeEach(() => {
    db = new ArtifactDB(':memory:');
  });

  it('returns all rows for a thread, ordered by segment_index ASC', () => {
    db.insert(makeInput({ thread_id: 1, segment_index: 0, thread_local_seq: 1, preset: 'universal', content_md: 'u0' }));
    db.insert(makeInput({ thread_id: 1, segment_index: 1, thread_local_seq: 2, preset: 'decision', content_md: 'd1' }));
    db.insert(makeInput({ thread_id: 1, segment_index: 2, thread_local_seq: 3, preset: 'universal', content_md: 'u2' }));

    const rows = db.findByThread(1);
    expect(rows).toHaveLength(3);
    expect(rows[0].segment_index).toBe(0);
    expect(rows[1].segment_index).toBe(1);
    expect(rows[2].segment_index).toBe(2);
  });

  it('does NOT return rows from other threads', () => {
    db.insert(makeInput({ thread_id: 1, segment_index: 0, thread_local_seq: 1 }));
    db.insert(makeInput({ thread_id: 2, segment_index: 0, thread_local_seq: 1 }));

    const rows = db.findByThread(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].thread_id).toBe(1);
  });

  it('returns empty array when no rows for thread', () => {
    expect(db.findByThread(42)).toEqual([]);
  });
});

describe('ArtifactDB: maxThreadLocalSeq', () => {
  let db: ArtifactDB;

  beforeEach(() => {
    db = new ArtifactDB(':memory:');
  });

  it('returns null when no rows exist for thread', () => {
    expect(db.maxThreadLocalSeq(1)).toBeNull();
  });

  it('returns the max thread_local_seq when populated', () => {
    db.insert(makeInput({ thread_id: 1, segment_index: 0, thread_local_seq: 3 }));
    db.insert(makeInput({ thread_id: 1, segment_index: 1, thread_local_seq: 7 }));
    db.insert(makeInput({ thread_id: 1, segment_index: 2, thread_local_seq: 2 }));

    expect(db.maxThreadLocalSeq(1)).toBe(7);
  });

  it('is scoped to the given thread_id', () => {
    db.insert(makeInput({ thread_id: 1, segment_index: 0, thread_local_seq: 10 }));
    db.insert(makeInput({ thread_id: 2, segment_index: 0, thread_local_seq: 5 }));

    expect(db.maxThreadLocalSeq(2)).toBe(5);
  });
});

describe('ArtifactDB: deleteById', () => {
  let db: ArtifactDB;

  beforeEach(() => {
    db = new ArtifactDB(':memory:');
  });

  it('round-trip: insert → delete → not findable', () => {
    const row = db.insert(makeInput());
    expect(db.fetchById(row.id)).not.toBeNull();

    db.deleteById(row.id);
    expect(db.fetchById(row.id)).toBeNull();
  });

  it('deleteById is a no-op for a non-existent id', () => {
    expect(() => db.deleteById(9999)).not.toThrow();
  });
});

describe('ArtifactDB: UNIQUE constraints', () => {
  let db: ArtifactDB;

  beforeEach(() => {
    db = new ArtifactDB(':memory:');
  });

  it('rejects duplicate (thread_id, segment_index)', () => {
    db.insert(makeInput({ thread_id: 1, segment_index: 0, thread_local_seq: 1 }));
    expect(() =>
      db.insert(makeInput({ thread_id: 1, segment_index: 0, thread_local_seq: 2 })),
    ).toThrow();
  });

  it('rejects duplicate (thread_id, thread_local_seq)', () => {
    db.insert(makeInput({ thread_id: 1, segment_index: 0, thread_local_seq: 1 }));
    expect(() =>
      db.insert(makeInput({ thread_id: 1, segment_index: 1, thread_local_seq: 1 })),
    ).toThrow();
  });

  it('allows same segment_index in different threads', () => {
    db.insert(makeInput({ thread_id: 1, segment_index: 0, thread_local_seq: 1 }));
    expect(() =>
      db.insert(makeInput({ thread_id: 2, segment_index: 0, thread_local_seq: 1 })),
    ).not.toThrow();
  });
});

describe('ArtifactDB: fetchByThreadLocalSeq (cross-thread isolation)', () => {
  let db: ArtifactDB;

  beforeEach(() => {
    db = new ArtifactDB(':memory:');
  });

  it('fetches correct row for (thread_id, thread_local_seq)', () => {
    const row = db.insert(makeInput({ thread_id: 1, segment_index: 0, thread_local_seq: 7 }));
    const found = db.fetchByThreadLocalSeq(1, 7);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(row.id);
  });

  it('thread-scoped: seq 7 in thread 1 is NOT visible from thread 2', () => {
    db.insert(makeInput({ thread_id: 1, segment_index: 0, thread_local_seq: 7 }));
    // thread 2 has no row with seq=7
    expect(db.fetchByThreadLocalSeq(2, 7)).toBeNull();
  });

  it('returns null when seq does not exist in the thread', () => {
    expect(db.fetchByThreadLocalSeq(1, 99)).toBeNull();
  });

  it('optional fields default to null when omitted', () => {
    const row = db.insert(makeInput());
    expect(row.synthesis_model).toBeNull();
    expect(row.synthesis_token_usage_json).toBeNull();
  });

  it('stores synthesis_model and synthesis_token_usage_json when provided', () => {
    const row = db.insert(makeInput({
      synthesis_model: 'claude-opus-4-7',
      synthesis_token_usage_json: '{"input":100,"output":200}',
    }));
    expect(row.synthesis_model).toBe('claude-opus-4-7');
    expect(row.synthesis_token_usage_json).toBe('{"input":100,"output":200}');
  });
});
