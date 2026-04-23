import type { HumanCritiqueStance } from '../council/human-critique.js';
import type { CritiquePromptResult } from '../council/human-critique-wiring.js';

export type PendingCritique =
  | { phase: 'awaiting-button' }
  | { phase: 'awaiting-text'; stance: HumanCritiqueStance };

interface RegisterInput {
  resolve: (result: CritiquePromptResult) => void;
}

interface InternalEntry {
  phase: 'awaiting-button' | 'awaiting-text';
  stance?: HumanCritiqueStance;
  resolve: (result: CritiquePromptResult) => void;
}

// Per-thread state for the Telegram InlineKeyboard critique flow.
// A critique lives through two phases: tap a button (awaiting-button), then
// optionally type the critique text (awaiting-text).
//
// The authoritative timeout lives in HumanCritiqueStore; when the store
// closes a window it calls back via wiring.cancelPrompt → resolveSkipped(),
// so this state is just UI bookkeeping. drain() covers bot.stop() shutdown.
export class PendingCritiqueState {
  private entries = new Map<number, InternalEntry>();

  register(threadId: number, input: RegisterInput): void {
    if (this.entries.has(threadId)) {
      throw new Error(`critique already pending for thread ${threadId}`);
    }
    this.entries.set(threadId, {
      phase: 'awaiting-button',
      resolve: input.resolve,
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

  // Skip all pending critiques — for shutdown so dangling entries don't
  // leak past bot.stop().
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
    this.entries.delete(threadId);
    entry.resolve({ kind: 'skipped' });
  }

  resolveSubmitted(threadId: number, content: string): void {
    const entry = this.entries.get(threadId);
    if (!entry) return;
    if (entry.phase !== 'awaiting-text' || !entry.stance) return;
    this.entries.delete(threadId);
    entry.resolve({ kind: 'submitted', stance: entry.stance, content });
  }
}
