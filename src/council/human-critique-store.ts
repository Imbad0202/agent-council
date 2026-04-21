import type { HumanCritiqueStance } from './human-critique.js';

export type SkipReason = 'timeout' | 'user-skip' | 'disabled';

export type CritiqueOutcome =
  | { kind: 'submitted'; stance: HumanCritiqueStance; content: string }
  | { kind: 'skipped'; reason: SkipReason };

export interface OpenOptions {
  prevAgent: string;
  nextAgent: string;
  timeoutMs: number;
}

export interface PendingWindow {
  prevAgent: string;
  nextAgent: string;
  openedAt: number;
  status: 'pending';
}

interface InternalWindow extends PendingWindow {
  resolve: (outcome: CritiqueOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Pending-window store for human critique injection between agent turns.
// Lifecycle mirrors BlindReviewStore: per-thread, in-memory, bot-restart clears.
// Difference: each window wraps a Promise so deliberation.ts can await the
// outcome without polling.
export class HumanCritiqueStore {
  private windows = new Map<number, InternalWindow>();

  open(threadId: number, opts: OpenOptions): Promise<CritiqueOutcome> {
    if (this.windows.has(threadId)) {
      throw new Error(`pending human-critique window exists for thread ${threadId}`);
    }
    return new Promise<CritiqueOutcome>((resolve) => {
      const timer = setTimeout(() => {
        const window = this.windows.get(threadId);
        if (!window) return;
        this.windows.delete(threadId);
        window.resolve({ kind: 'skipped', reason: 'timeout' });
      }, opts.timeoutMs);

      this.windows.set(threadId, {
        prevAgent: opts.prevAgent,
        nextAgent: opts.nextAgent,
        openedAt: Date.now(),
        status: 'pending',
        resolve,
        timer,
      });
    });
  }

  get(threadId: number): PendingWindow | undefined {
    const w = this.windows.get(threadId);
    if (!w) return undefined;
    const { prevAgent, nextAgent, openedAt, status } = w;
    return { prevAgent, nextAgent, openedAt, status };
  }

  submit(
    threadId: number,
    input: { stance: HumanCritiqueStance; content: string },
  ): void {
    const window = this.windows.get(threadId);
    if (!window) return;
    clearTimeout(window.timer);
    this.windows.delete(threadId);
    window.resolve({ kind: 'submitted', stance: input.stance, content: input.content });
  }

  skip(threadId: number, reason: SkipReason): void {
    const window = this.windows.get(threadId);
    if (!window) return;
    clearTimeout(window.timer);
    this.windows.delete(threadId);
    window.resolve({ kind: 'skipped', reason });
  }
}
