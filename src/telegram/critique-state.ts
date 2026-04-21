import type { HumanCritiqueStance } from '../council/human-critique.js';
import type { CritiquePromptResult } from '../council/human-critique-wiring.js';

export type PendingCritique =
  | { phase: 'awaiting-button' }
  | { phase: 'awaiting-text'; stance: HumanCritiqueStance };

interface RegisterInput {
  resolve: (result: CritiquePromptResult) => void;
  reject: (err: Error) => void;
  timeoutMs: number;
}

interface InternalEntry {
  phase: 'awaiting-button' | 'awaiting-text';
  stance?: HumanCritiqueStance;
  resolve: (result: CritiquePromptResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Per-thread state for the Telegram InlineKeyboard critique flow.
// A critique lives through two phases: tap a button (awaiting-button), then
// optionally type the critique text (awaiting-text). Timeout falls back to
// skipped so a forgotten prompt never stalls the deliberation loop.
export class PendingCritiqueState {
  private entries = new Map<number, InternalEntry>();

  register(threadId: number, input: RegisterInput): void {
    if (this.entries.has(threadId)) {
      throw new Error(`critique already pending for thread ${threadId}`);
    }
    const timer = setTimeout(() => {
      this.resolveSkipped(threadId);
    }, input.timeoutMs);
    this.entries.set(threadId, {
      phase: 'awaiting-button',
      resolve: input.resolve,
      reject: input.reject,
      timer,
    });
  }

  get(threadId: number): PendingCritique | undefined {
    const entry = this.entries.get(threadId);
    if (!entry) return undefined;
    if (entry.phase === 'awaiting-text' && entry.stance) {
      return { phase: 'awaiting-text', stance: entry.stance };
    }
    return { phase: 'awaiting-button' };
  }

  // Skip all pending critiques — for shutdown so setTimeout timers don't
  // linger and hold the event loop open past bot.stop().
  drain(): void {
    for (const threadId of [...this.entries.keys()]) {
      this.resolveSkipped(threadId);
    }
  }

  advanceToText(threadId: number, stance: HumanCritiqueStance): void {
    const entry = this.entries.get(threadId);
    if (!entry) return;
    entry.phase = 'awaiting-text';
    entry.stance = stance;
  }

  resolveSkipped(threadId: number): void {
    const entry = this.entries.get(threadId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.entries.delete(threadId);
    entry.resolve({ kind: 'skipped' });
  }

  resolveSubmitted(threadId: number, content: string): void {
    const entry = this.entries.get(threadId);
    if (!entry) return;
    if (entry.phase !== 'awaiting-text' || !entry.stance) return;
    clearTimeout(entry.timer);
    this.entries.delete(threadId);
    entry.resolve({ kind: 'submitted', stance: entry.stance, content });
  }
}
