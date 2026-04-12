import type { EventBus } from '../events/bus.js';
import type { MemoryDB } from './db.js';
import type { MemoryRecord } from '../types.js';

export class ActiveRecall {
  private bus: EventBus;
  private db: MemoryDB;
  private injectionTracker: Map<string, Map<number, number>> = new Map(); // memoryId → threadId → count

  constructor(bus: EventBus, db: MemoryDB) {
    this.bus = bus;
    this.db = db;
    this.bus.on('deliberation.started', (p) => this.onDeliberationStarted(p.threadId));
    this.bus.on('session.ended', (p) => this.clearSession(p.threadId));
  }

  // Layer 1: session-start context for system prompt
  getSessionContext(keywords: string[]): string {
    const memories = this.queryRelevantMemories(keywords);
    if (memories.length === 0) return '';
    const lines = memories.map(m => `[ref:${m.id}] ${m.contentPreview} (confidence: ${m.confidence})`);
    return `== Relevant Historical Decisions ==\n${lines.join('\n')}\n\nYou may continue, challenge, or overturn these conclusions. State your stance explicitly.`;
  }

  // Layer 2: per-turn context for challenge prompt
  getPerTurnContext(keywords: string[], threadId: number): string {
    const memories = this.queryRelevantMemories(keywords);
    const filtered = memories.filter(m => this.getInjectionCount(m.id, threadId) < 2);
    if (filtered.length === 0) return '';
    for (const m of filtered) this.markInjected(m.id, threadId);
    const lines = filtered.map(m => `[ref:${m.id}] ${m.contentPreview}`);
    return `== Related past decisions ==\n${lines.join('\n')}`;
  }

  markInjected(memoryId: string, threadId: number): void {
    if (!this.injectionTracker.has(memoryId)) this.injectionTracker.set(memoryId, new Map());
    const tm = this.injectionTracker.get(memoryId)!;
    tm.set(threadId, (tm.get(threadId) ?? 0) + 1);
  }

  private getInjectionCount(memoryId: string, threadId: number): number {
    return this.injectionTracker.get(memoryId)?.get(threadId) ?? 0;
  }

  private clearSession(threadId: number): void {
    for (const tm of this.injectionTracker.values()) tm.delete(threadId);
  }

  private onDeliberationStarted(threadId: number): void {
    const memories = this.queryRelevantMemories([]);
    if (memories.length > 0) {
      this.bus.emit('memory.injected', { threadId, agentId: 'all', memories: memories.map(m => m.id) });
    }
  }

  private queryRelevantMemories(keywords: string[]): MemoryRecord[] {
    if (keywords.length === 0) {
      // Return all high-confidence principles and rules (from any agent) without FTS
      const principles = this.db.listAllMemoriesByType('principle').filter(m => m.confidence >= 0.7);
      const rules = this.db.listAllMemoriesByType('rule').filter(m => m.confidence >= 0.7);
      return [...principles, ...rules].slice(0, 5);
    }
    const query = keywords.join(' ');
    return this.db.searchMemories(query)
      .filter(m => (m.type === 'principle' || m.type === 'rule') && m.confidence >= 0.7)
      .slice(0, 5);
  }
}
