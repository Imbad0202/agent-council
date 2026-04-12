import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ActiveRecall } from '../../src/memory/active-recall.js';
import { EventBus } from '../../src/events/bus.js';
import { MemoryDB } from '../../src/memory/db.js';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MemoryRecord } from '../../src/types.js';

describe('ActiveRecall', () => {
  const testDir = join(tmpdir(), 'agent-council-active-recall-test');
  const testDbPath = join(testDir, 'brain.db');
  let db: MemoryDB;
  let bus: EventBus;
  let recall: ActiveRecall;

  const makeRecord = (overrides: Partial<MemoryRecord> & { id: string }): MemoryRecord => ({
    agentId: 'huahua',
    type: 'principle',
    topic: 'architecture',
    confidence: 0.9,
    outcome: 'decision',
    usageCount: 1,
    lastUsed: '2026-04-10',
    createdAt: '2026-04-01',
    contentPreview: 'Default principle content.',
    ...overrides,
  });

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    db = new MemoryDB(testDbPath);
    bus = new EventBus();
    recall = new ActiveRecall(bus, db);
  });

  afterEach(() => {
    db.close();
  });

  it('getSessionContext returns formatted string with matching principles', () => {
    db.insertMemory(makeRecord({
      id: 'huahua/principles/principle-arch.md',
      topic: 'architecture',
      contentPreview: 'Favor simplicity over complexity.',
      confidence: 0.9,
    }));

    const ctx = recall.getSessionContext(['architecture']);
    expect(ctx).toContain('== Relevant Historical Decisions ==');
    expect(ctx).toContain('[ref:huahua/principles/principle-arch.md]');
    expect(ctx).toContain('Favor simplicity over complexity.');
    expect(ctx).toContain('confidence: 0.9');
    expect(ctx).toContain('State your stance explicitly.');
  });

  it('getSessionContext returns empty string when no matching memories', () => {
    // No memories inserted
    const ctx = recall.getSessionContext(['nonexistent-topic-xyz']);
    expect(ctx).toBe('');
  });

  it('getSessionContext ignores memories below confidence threshold', () => {
    db.insertMemory(makeRecord({
      id: 'huahua/principles/principle-low.md',
      topic: 'architecture',
      contentPreview: 'Low confidence principle.',
      confidence: 0.5,
    }));

    const ctx = recall.getSessionContext(['architecture']);
    expect(ctx).toBe('');
  });

  it('getSessionContext ignores session-type memories (only principle/rule)', () => {
    db.insertMemory(makeRecord({
      id: 'huahua/sessions/session-arch.md',
      type: 'session',
      topic: 'architecture',
      contentPreview: 'Session content about architecture.',
      confidence: 0.9,
    }));

    const ctx = recall.getSessionContext(['architecture']);
    expect(ctx).toBe('');
  });

  it('getPerTurnContext returns memories not yet at injection limit', () => {
    db.insertMemory(makeRecord({
      id: 'huahua/principles/principle-arch.md',
      topic: 'architecture',
      contentPreview: 'Favor simplicity over complexity.',
      confidence: 0.9,
    }));

    const ctx = recall.getPerTurnContext(['architecture'], 42);
    expect(ctx).toContain('== Related past decisions ==');
    expect(ctx).toContain('[ref:huahua/principles/principle-arch.md]');
    expect(ctx).toContain('Favor simplicity over complexity.');
  });

  it('deduplicates: same memory injected max 2 times per session', () => {
    const memId = 'huahua/principles/principle-arch.md';
    db.insertMemory(makeRecord({
      id: memId,
      topic: 'architecture',
      contentPreview: 'Favor simplicity over complexity.',
      confidence: 0.9,
    }));

    const threadId = 99;

    // First injection
    const ctx1 = recall.getPerTurnContext(['architecture'], threadId);
    expect(ctx1).toContain('== Related past decisions ==');

    // Second injection — still within limit (count=1 < 2)
    const ctx2 = recall.getPerTurnContext(['architecture'], threadId);
    expect(ctx2).toContain('== Related past decisions ==');

    // Third injection — count=2 >= 2, should be filtered out
    const ctx3 = recall.getPerTurnContext(['architecture'], threadId);
    expect(ctx3).toBe('');
  });

  it('different threads have independent injection counts', () => {
    const memId = 'huahua/principles/principle-arch.md';
    db.insertMemory(makeRecord({
      id: memId,
      topic: 'architecture',
      contentPreview: 'Favor simplicity over complexity.',
      confidence: 0.9,
    }));

    // Exhaust thread 1
    recall.getPerTurnContext(['architecture'], 1);
    recall.getPerTurnContext(['architecture'], 1);
    const ctx1Exhausted = recall.getPerTurnContext(['architecture'], 1);
    expect(ctx1Exhausted).toBe('');

    // Thread 2 still gets the memory
    const ctx2 = recall.getPerTurnContext(['architecture'], 2);
    expect(ctx2).toContain('== Related past decisions ==');
  });

  it('emits memory.injected on deliberation.started', () => {
    db.insertMemory(makeRecord({
      id: 'huahua/principles/principle-arch.md',
      type: 'principle',
      topic: 'architecture',
      contentPreview: 'Principle content.',
      confidence: 0.8,
    }));

    const emittedEvents: Array<{ threadId: number; agentId: string; memories: string[] }> = [];
    bus.on('memory.injected', (p) => emittedEvents.push(p));

    bus.emit('deliberation.started', {
      threadId: 10,
      participants: ['huahua'],
      roles: { huahua: 'advocate' },
      structure: 'free',
    });

    // Allow synchronous handler to run
    expect(emittedEvents.length).toBe(1);
    expect(emittedEvents[0].threadId).toBe(10);
    expect(emittedEvents[0].agentId).toBe('all');
    expect(emittedEvents[0].memories).toContain('huahua/principles/principle-arch.md');
  });

  it('does not emit memory.injected when no relevant memories exist', () => {
    // No memories inserted
    const emittedEvents: unknown[] = [];
    bus.on('memory.injected', (p) => emittedEvents.push(p));

    bus.emit('deliberation.started', {
      threadId: 11,
      participants: [],
      roles: {},
      structure: 'free',
    });

    expect(emittedEvents.length).toBe(0);
  });

  it('clearSession removes injection tracking for that thread', () => {
    const memId = 'huahua/principles/principle-arch.md';
    db.insertMemory(makeRecord({
      id: memId,
      topic: 'architecture',
      contentPreview: 'Favor simplicity over complexity.',
      confidence: 0.9,
    }));

    const threadId = 55;

    // Exhaust the injection limit
    recall.getPerTurnContext(['architecture'], threadId);
    recall.getPerTurnContext(['architecture'], threadId);
    const ctxBeforeClear = recall.getPerTurnContext(['architecture'], threadId);
    expect(ctxBeforeClear).toBe('');

    // Session ended should clear tracking
    bus.emit('session.ended', { threadId, topic: 'architecture', outcome: 'decision' });

    // Now the memory can be injected again
    const ctxAfterClear = recall.getPerTurnContext(['architecture'], threadId);
    expect(ctxAfterClear).toContain('== Related past decisions ==');
  });
});
