import type { HumanCritiqueStance } from './human-critique.js';

// Injected into the next agent's challenge prompt when a user submits a
// critique mid-deliberation. Parallel to PATTERN_INJECTION_PROMPTS.
export const HUMAN_CRITIQUE_PROMPTS: Record<HumanCritiqueStance, (content: string) => string> = {
  question: (c) =>
    `人類在你發言前提出一個問題：「${c}」。在你的回應裡明確回答這個問題，不要繞過。`,
  challenge: (c) =>
    `人類在你發言前直接質疑：「${c}」。在你的回應裡明確回應這個質疑，不要閃躲。`,
  addPremise: (c) =>
    `人類在你發言前補充一個前提：「${c}」。把這個前提納入你的推理，顯示你吸收了這個約束。`,
};

export function buildCritiquePrompt(stance: HumanCritiqueStance, content: string): string {
  return HUMAN_CRITIQUE_PROMPTS[stance](content);
}
