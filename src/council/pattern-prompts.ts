import type { PatternType } from '../types.js';

/**
 * Shared challenge prompts for detected anti-patterns.
 * Used by PatternDetector, DeliberationHandler, and FacilitatorAgent.
 */
export const PATTERN_INJECTION_PROMPTS: Record<PatternType, string> = {
  mirror: '你的回覆跟對方高度重疊。提出一個對方沒提到的面向。',
  fake_dissent: '你聲稱不同意但結論一致。什麼情況下你會得出不同結論？',
  quick_surrender: '你在一次反對後就改變立場。那個反對真的推翻了你的論點嗎？',
  authority_submission: '你在人類表態後改變了觀點。請基於論點本身評估，不是因為人類同意了對方。',
};
