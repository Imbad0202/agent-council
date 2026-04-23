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
  listeners: Set<() => void>;
}

// Pending-window store for human critique injection between agent turns.
// Lifecycle mirrors BlindReviewStore: per-thread, in-memory, bot-restart clears.
// Difference: each window wraps a Promise so deliberation.ts can await the
// outcome without polling.
//
// Authoritative timer: the store owns the single setTimeout for each window.
// Adapters (CLI / Telegram) subscribe via onResolved() and drain their own
// per-thread bookkeeping when the window closes — they do not run parallel
// timers.
export class HumanCritiqueStore {
  private windows = new Map<number, InternalWindow>();

  open(threadId: number, opts: OpenOptions): Promise<CritiqueOutcome> {
    if (this.windows.has(threadId)) {
      throw new Error(`pending human-critique window exists for thread ${threadId}`);
    }
    return new Promise<CritiqueOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.close(threadId, { kind: 'skipped', reason: 'timeout' });
      }, opts.timeoutMs);

      this.windows.set(threadId, {
        prevAgent: opts.prevAgent,
        nextAgent: opts.nextAgent,
        openedAt: Date.now(),
        status: 'pending',
        resolve,
        timer,
        listeners: new Set(),
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
    this.close(threadId, { kind: 'submitted', stance: input.stance, content: input.content });
  }

  skip(threadId: number, reason: SkipReason): void {
    this.close(threadId, { kind: 'skipped', reason });
  }

  // Subscribe to window closure for the given thread. Returns an unsubscribe.
  // Used by wiring.dispatchCritiqueRequest so the adapter can drain its
  // pending UI entry when the store's timer fires first. Fires at most once.
  // Fires immediately if no window exists for threadId — callers must subscribe
  // AFTER open() to observe that window (dispatchCritiqueRequest relies on the
  // requested→promptUser ordering for this).
  onResolved(threadId: number, listener: () => void): () => void {
    const window = this.windows.get(threadId);
    if (!window) {
      listener();
      return () => {};
    }
    window.listeners.add(listener);
    return () => { window.listeners.delete(listener); };
  }

  private close(threadId: number, outcome: CritiqueOutcome): void {
    const window = this.windows.get(threadId);
    if (!window) return;
    clearTimeout(window.timer);
    this.windows.delete(threadId);
    const listeners = [...window.listeners];
    for (const l of listeners) {
      try { l(); } catch { /* listener errors must not cancel siblings or the promise resolve */ }
    }
    window.resolve(outcome);
  }
}
