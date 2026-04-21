import { describe, it, expect, beforeEach } from 'vitest';
import { AntiSycophancyEngine } from '../../src/council/anti-sycophancy.js';
import type { CouncilConfig } from '../../src/types.js';

const config: CouncilConfig['antiSycophancy'] = {
  disagreementThreshold: 0.2,
  consecutiveLowRounds: 3,
  challengeAngles: ['cost'],
};

describe('AntiSycophancyEngine — shouldInviteHumanCritique', () => {
  let engine: AntiSycophancyEngine;
  beforeEach(() => {
    engine = new AntiSycophancyEngine(config);
  });

  it('returns false when disagreement is healthy', () => {
    engine.recordClassification('opposition');
    engine.recordClassification('conditional');
    engine.recordClassification('opposition');
    expect(engine.shouldInviteHumanCritique()).toBe(false);
  });

  it('returns true when 3 consecutive agreements below threshold', () => {
    engine.recordClassification('agreement');
    engine.recordClassification('agreement');
    engine.recordClassification('agreement');
    expect(engine.shouldInviteHumanCritique()).toBe(true);
  });

  it('returns false when fewer than consecutiveLowRounds classifications recorded', () => {
    engine.recordClassification('agreement');
    engine.recordClassification('agreement');
    expect(engine.shouldInviteHumanCritique()).toBe(false);
  });

  it('aligns with checkConvergence return value: non-null implies shouldInvite=true', () => {
    engine.recordClassification('agreement');
    engine.recordClassification('agreement');
    engine.recordClassification('agreement');
    const convergencePrompt = engine.checkConvergence();
    const invite = engine.shouldInviteHumanCritique();
    expect(convergencePrompt).not.toBeNull();
    expect(invite).toBe(true);
  });
});
