import type { CouncilMessage, CouncilConfig } from '../types.js';

type ResponseClassification = 'opposition' | 'conditional' | 'agreement';

const OPPOSITION_SIGNALS = [
  'i disagree', 'however', 'another angle', 'on the contrary',
  'i don\'t think', 'the problem with', 'but that ignores',
  '不同意', '但是', '另一個角度', '問題在於', '忽略了',
];

const CONDITIONAL_SIGNALS = [
  'partially agree', 'agree but', 'agree, but', 'part of that is right',
  'mostly agree', 'agree in principle',
  '部分同意', '原則上同意', '大致同意但',
];

const AGREEMENT_SIGNALS = [
  'i agree', 'exactly', 'completely correct', 'absolutely right',
  'i think so too', 'well said', 'no disagreement',
  '同意', '完全正確', '沒錯', '說得對', '贊同',
];

export class AntiSycophancyEngine {
  private config: CouncilConfig['antiSycophancy'];
  private recentClassifications: ResponseClassification[] = [];

  constructor(config: CouncilConfig['antiSycophancy']) {
    this.config = config;
  }

  generateChallengePrompt(previousMessage: CouncilMessage): string {
    const excerpt = previousMessage.content.length > 200
      ? previousMessage.content.slice(0, 200) + '...'
      : previousMessage.content;

    return `Before responding, consider: the previous agent said: "${excerpt}"

List at least 2 potential problems, risks, or blind spots in that position. Then give your own perspective — you may agree, disagree, or partially agree, but your reasoning must be independent.`;
  }

  classifyResponse(content: string): ResponseClassification {
    const lower = content.toLowerCase();

    if (OPPOSITION_SIGNALS.some((s) => lower.includes(s))) {
      return 'opposition';
    }

    if (CONDITIONAL_SIGNALS.some((s) => lower.includes(s))) {
      return 'conditional';
    }

    if (AGREEMENT_SIGNALS.some((s) => lower.includes(s))) {
      return 'agreement';
    }

    return 'conditional';
  }

  recordClassification(classification: ResponseClassification): void {
    this.recentClassifications.push(classification);
  }

  checkConvergence(): string | null {
    const { consecutiveLowRounds, disagreementThreshold, challengeAngles } = this.config;

    if (this.recentClassifications.length < consecutiveLowRounds) {
      return null;
    }

    const recent = this.recentClassifications.slice(-consecutiveLowRounds);
    const disagreements = recent.filter((c) => c === 'opposition' || c === 'conditional').length;
    const rate = disagreements / recent.length;

    if (rate < disagreementThreshold) {
      const angle = challengeAngles[Math.floor(Math.random() * challengeAngles.length)];
      return `Your perspectives are converging. Re-examine this issue from the angle of ${angle}. What are you both missing? What assumption hasn't been challenged?`;
    }

    return null;
  }

  reset(): void {
    this.recentClassifications = [];
  }
}
