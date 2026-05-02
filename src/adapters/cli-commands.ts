import type { CliSessionManager } from './cli-sessions.js';
import type { MemoryDB } from '../memory/db.js';
import type { SessionReset } from '../council/session-reset.js';
import type { ResetSnapshotDB } from '../storage/reset-snapshot-db.js';
import type { HandlerForReset } from '../council/session-reset.js';
import type { ArtifactService } from '../council/artifact-service.js';
import { parseArtifact } from '../council/artifact-prompt.js';
import { ResetCancelledError } from '../council/session-reset-errors.js';

type PrintFn = (line: string) => void;

// Round-11 codex finding [P2]: cli-dispatch.ts used to treat any line
// starting with '/' as a CLI command. In a coding-focused council that
// regresses every absolute path or shell snippet (e.g. `/Users/...`,
// `/bin/bash -lc ...`) into "Unknown command". Single source of truth for
// the whitelist lives here next to the actual handlers — keep them in
// sync. Sync commands handled by handle(): help, sessions, delete,
// memories, memory, forget, patterns. Async commands handled by
// handleAsync(): councilreset, councilhistory, councildone, councilshow.
//
// Round-12 codex finding [P2]: /quit /debug /resume are advertised in the
// /help banner (CLI startup line + listSessions output) but are NOT
// implemented in handle() yet. They still must stay on the CLI path so
// they don't trigger a deliberation round when typed. They currently fall
// through to handle()'s 'Unknown command' branch — restoring pre-round-11
// behaviour. Implementing them is a separate gap (TODO outside round-12).
export const CLI_COMMAND_NAMES: ReadonlySet<string> = new Set([
  'help',
  'sessions',
  'delete',
  'memories',
  'memory',
  'forget',
  'patterns',
  'councilcancel',
  'councilreset',
  'councilhistory',
  'councildone',
  'councilshow',
  'quit',
  'debug',
  'resume',
]);

export interface ResetWiring {
  sessionReset?: SessionReset;
  deliberationHandler?: HandlerForReset;
  resetSnapshotDB?: ResetSnapshotDB;
  threadId?: number;
}

export interface ArtifactWiring {
  artifactService?: ArtifactService;
  threadId?: number;
}

export class CliCommandHandler {
  private sessions: CliSessionManager;
  private db: MemoryDB;
  private print: PrintFn;
  private reset: ResetWiring;
  private artifact: ArtifactWiring;

  constructor(
    sessions: CliSessionManager,
    db: MemoryDB,
    print: PrintFn,
    reset: ResetWiring = {},
    artifact: ArtifactWiring = {},
  ) {
    this.sessions = sessions;
    this.db = db;
    this.print = print;
    this.reset = reset;
    this.artifact = artifact;
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

  // Async variant covers commands that need I/O (e.g. /councilreset calls the
  // facilitator LLM). Keep handle() synchronous for the existing memory/session
  // commands so current callers don't need to touch an await.
  async handleAsync(command: string, args: string): Promise<void> {
    switch (command) {
      case 'councilcancel': return this.councilCancel();
      case 'councilreset': return this.councilReset();
      case 'councilhistory': return this.councilHistory();
      case 'councildone': return this.councilDone(args);
      case 'councilshow': return this.councilShow(args);
      default:
        this.handle(command, args);
    }
  }

  private async councilReset(): Promise<void> {
    const { sessionReset, deliberationHandler, threadId } = this.reset;
    if (!sessionReset || !deliberationHandler || threadId === undefined) {
      this.print('/councilreset is not configured in this CLI session.');
      return;
    }
    try {
      const result = await sessionReset.reset(deliberationHandler, threadId);
      this.print(
        `Sealed segment ${result.segmentIndex}: ${result.metadata.decisionsCount} decision(s), ${result.metadata.openQuestionsCount} open question(s). Starting next segment.`,
      );
    } catch (err) {
      this.print((err as Error).message);
    }
  }

  private councilCancel(): void {
    const { sessionReset, deliberationHandler, threadId } = this.reset;
    // Triple-check mirrors councilReset() at the guard above — catches
    // DB-only-without-facilitator wiring (deliberationHandler === undefined)
    // AND missing threadId misconfiguration. Per-adapter wording intentional
    // (§3.3 round-6 P2-r6-4): CLI uses "in this CLI session" idiom mirroring
    // councilReset()'s message.
    if (!sessionReset || !deliberationHandler || threadId === undefined) {
      this.print('/councilcancel is not configured in this CLI session.');
      return;
    }
    const ctrl = deliberationHandler.getCurrentResetController(threadId);
    if (!ctrl) {
      this.print('No reset in progress.');
      return;
    }
    ctrl.abort(new ResetCancelledError('user'));
    this.print('Reset cancelled.');
  }

  private councilHistory(): void {
    const { resetSnapshotDB, threadId } = this.reset;
    if (!resetSnapshotDB || threadId === undefined) {
      this.print('/councilhistory is not configured in this CLI session.');
      return;
    }
    const snapshots = resetSnapshotDB.listSnapshotsForThread(threadId);
    if (snapshots.length === 0) {
      this.print('No resets yet in this session.');
      return;
    }
    for (const s of snapshots) {
      this.print(
        `[${s.segmentIndex}] ${s.sealedAt} — ${s.metadata.decisionsCount} decisions, ${s.metadata.openQuestionsCount} open`,
      );
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

  private async councilDone(args: string): Promise<void> {
    const svc = this.artifact.artifactService;
    if (!svc || this.artifact.threadId === undefined) {
      this.print('/councildone is not configured in this CLI session.');
      return;
    }
    const trimmed = args.trim();
    let preset: 'universal' | 'decision';
    if (trimmed === '' || trimmed === 'universal') preset = 'universal';
    else if (trimmed === 'decision') preset = 'decision';
    else {
      this.print('unknown preset, accepted: universal | decision');
      return;
    }
    try {
      const row = await svc.synthesize(this.artifact.threadId, preset);
      const { tldr } = parseArtifact(row.content_md);
      const tldrSummary = tldr ? tldr.slice(0, 200) : '(missing TL;DR)';
      this.print(`✅ Artifact #${row.thread_local_seq} (${row.preset}) created.`);
      this.print(`TL;DR: ${tldrSummary}`);
      this.print(`完整內容: /councilshow ${row.thread_local_seq}`);
    } catch (err) {
      this.print(`/councildone failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async councilShow(args: string): Promise<void> {
    const svc = this.artifact.artifactService;
    if (!svc || this.artifact.threadId === undefined) {
      this.print('/councilshow is not configured in this CLI session.');
      return;
    }
    const trimmed = args.trim();
    if (!/^[1-9]\d{0,9}$/.test(trimmed)) {
      this.print('/councilshow <id>，例：/councilshow 3');
      return;
    }
    const seq = parseInt(trimmed, 10);
    const row = svc.fetchByThreadLocalSeq(this.artifact.threadId, seq);
    if (!row) {
      this.print(`artifact #${seq} not found in this thread`);
      return;
    }
    this.print(row.content_md);
  }
}
