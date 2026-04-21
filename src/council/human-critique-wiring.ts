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
export interface HumanCritiqueWiring {
  store: HumanCritiqueStore;
  promptUser: (req: CritiqueRequest) => Promise<CritiquePromptResult>;
}

// Drive the wiring for one critique request: prompt user, then funnel the
// result into the store. Shared helper so CLI and Telegram adapters don't
// duplicate the submit/skip branching.
export async function dispatchCritiqueRequest(
  wiring: HumanCritiqueWiring | undefined,
  req: CritiqueRequest,
): Promise<void> {
  if (!wiring) return;
  let result: CritiquePromptResult;
  try {
    result = await wiring.promptUser(req);
  } catch {
    // Adapter-side failure (readline closed, network blip) falls through to
    // skip — we never want to leave the critique window dangling and stall
    // the deliberation loop.
    wiring.store.skip(req.threadId, 'user-skip');
    return;
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
