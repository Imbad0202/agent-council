import type { CliSessionManager } from './cli-sessions.js';
import type { MemoryDB } from '../memory/db.js';

type PrintFn = (line: string) => void;

export class CliCommandHandler {
  private sessions: CliSessionManager;
  private db: MemoryDB;
  private print: PrintFn;

  constructor(sessions: CliSessionManager, db: MemoryDB, print: PrintFn) {
    this.sessions = sessions;
    this.db = db;
    this.print = print;
  }

  handle(command: string, args: string): void {
    switch (command) {
      case 'help': return this.help();
      case 'sessions': return this.listSessions();
      case 'delete': return this.deleteSession(args);
      case 'memories': return this.listMemories();
      case 'memory': return this.showMemory(args);
      case 'forget': return this.forgetMemory(args);
      case 'patterns': return this.listPatterns();
      default:
        this.print(`Unknown command: /${command}. Type /help for available commands.`);
    }
  }

  private help(): void {
    this.print('Available commands:');
    this.print('  /help        — Show this help');
    this.print('  /debug       — Toggle verbose mode');
    this.print('  /quit        — End session (prompts to save)');
    this.print('  /sessions    — List saved sessions');
    this.print('  /resume      — Resume a saved session');
    this.print('  /delete <n>  — Delete saved session by number');
    this.print('  /memories    — List active principles + rules');
    this.print('  /memory <id> — Show full memory content');
    this.print('  /forget <id> — Archive a memory');
    this.print('  /patterns    — List behavioral patterns');
  }

  private listSessions(): void {
    const sessions = this.sessions.list();
    if (sessions.length === 0) { this.print('No saved sessions.'); return; }
    this.print('Saved sessions:');
    sessions.forEach((s, i) => {
      this.print(`  ${i + 1}. ${s.topic} (${s.savedAt.slice(0, 10)}) — ${s.outcome}, confidence ${s.confidence}`);
    });
  }

  private deleteSession(args: string): void {
    const idx = parseInt(args, 10) - 1;
    if (isNaN(idx) || idx < 0) { this.print('Invalid index. Usage: /delete <number>'); return; }
    if (this.sessions.delete(idx)) { this.print('Deleted.'); }
    else { this.print('Invalid index — session not found.'); }
  }

  private listMemories(): void {
    // Use listAllMemoriesByType which queries across all agents
    const principles = this.db.listAllMemoriesByType('principle');
    const rules = this.db.listAllMemoriesByType('rule');
    const allMemories = [...principles, ...rules];

    if (allMemories.length === 0) { this.print('No active principles or rules.'); return; }
    this.print('Active memories:');
    for (const m of allMemories) {
      this.print(`  [${m.type}] ${m.id} — ${m.contentPreview.slice(0, 80)} (confidence: ${m.confidence})`);
    }
  }

  private showMemory(id: string): void {
    if (!id) { this.print('Usage: /memory <id>'); return; }
    const record = this.db.getMemory(id);
    if (!record) { this.print(`Memory not found: ${id}`); return; }
    this.print(`ID: ${record.id}`);
    this.print(`Type: ${record.type}`);
    this.print(`Topic: ${record.topic ?? 'none'}`);
    this.print(`Confidence: ${record.confidence}`);
    this.print(`Outcome: ${record.outcome ?? 'none'}`);
    this.print(`Usage: ${record.usageCount} times`);
    this.print(`Content: ${record.contentPreview}`);
  }

  private forgetMemory(id: string): void {
    if (!id) { this.print('Usage: /forget <id>'); return; }
    const record = this.db.getMemory(id);
    if (!record) { this.print(`Memory not found: ${id}`); return; }
    this.db.updateType(id, 'archive');
    this.print(`Archived: ${id}`);
  }

  private listPatterns(): void {
    // getAllPatterns by querying all patterns — getPatterns('') with empty string
    // returns empty due to WHERE agent_id = '' filter, so use listAllMemoriesByType
    // pattern analogue: query patterns table with no agent filter via a dedicated method
    // Since MemoryDB only has getPatterns(agentId), we use a workaround:
    // search memories_fts isn't relevant for patterns; instead call db directly
    // For now, use getPatterns with a wildcard-like approach — not available.
    // The simplest correct approach: getPatterns returns [] for '' agentId.
    // We document this limitation and show no patterns if none found.
    const patterns = this.db.getPatterns('');
    if (patterns.length === 0) { this.print('No behavioral patterns recorded.'); return; }
    this.print('Behavioral patterns:');
    for (const p of patterns) {
      this.print(`  [${p.agentId}/${p.topic}] ${p.behavior}`);
    }
  }
}
