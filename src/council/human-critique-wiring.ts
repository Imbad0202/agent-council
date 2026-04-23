import type { HumanCritiqueStore } from './human-critique-store.js';
import type { HumanCritiqueStance } from './human-critique.js';

export interface CritiqueRequest {
  threadId: number;
  prevAgent: string;
  nextAgent: string;
}

export type CritiquePromptResult =
  | { kind: 'submitted'; stance: HumanCritiqueStance; content: string }
  | { kind: 'skipped' };

// Wiring between an adapter (CLI / Telegram) and the HumanCritiqueStore.
// Adapters consume the `human-critique.requested` event by calling
// promptUser(), then call store.submit() or store.skip() based on the result.
// Optional cancelPrompt lets the store reclaim authority when its timeout
// fires first: store is the single source of truth for the timer, adapter
// state only holds UI bookkeeping.
export interface HumanCritiqueWiring {
  store: HumanCritiqueStore;
  promptUser: (req: CritiqueRequest) => Promise<CritiquePromptResult>;
  cancelPrompt?: (threadId: number) => void;
}

// Drive the wiring for one critique request: prompt user, funnel the result
// into the store, and arm the store's timer as the authoritative timeout. If
// the store times out before the user responds, cancelPrompt drains the
// adapter-side pending entry so the promptUser promise resolves instead of
// leaking.
export async function dispatchCritiqueRequest(
  wiring: HumanCritiqueWiring | undefined,
  req: CritiqueRequest,
): Promise<void> {
  if (!wiring) return;

  // If the store resolves first (timeout, external skip, shutdown), tell the
  // adapter to drain its pending entry so the outer promptUser promise ends.
  const unsubscribe = wiring.store.onResolved(req.threadId, () => {
    wiring.cancelPrompt?.(req.threadId);
  });

  let result: CritiquePromptResult;
  try {
    result = await wiring.promptUser(req);
  } catch {
    // Adapter-side failure (readline closed, network blip) falls through to
    // skip — we never want to leave the critique window dangling and stall
    // the deliberation loop.
    wiring.store.skip(req.threadId, 'user-skip');
    return;
  } finally {
    unsubscribe();
  }

  if (result.kind === 'submitted') {
    wiring.store.submit(req.threadId, {
      stance: result.stance,
      content: result.content,
    });
  } else {
    wiring.store.skip(req.threadId, 'user-skip');
  }
}
