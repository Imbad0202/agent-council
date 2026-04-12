import { describe, it, expect, beforeEach } from 'vitest';
import { AntiSycophancyEngine } from '../../src/council/anti-sycophancy.js';
import type { CouncilMessage, CouncilConfig } from '../../src/types.js';

const config: CouncilConfig['antiSycophancy'] = {
  disagreementThreshold: 0.2,
  consecutiveLowRounds: 3,
  challengeAngles: ['cost', 'risk', 'alternatives', 'long-term impact'],
};

describe('AntiSycophancyEngine', () => {
  let engine: AntiSycophancyEngine;

  beforeEach(() => {
    engine = new AntiSycophancyEngine(config);
  });

  describe('generateChallengePrompt', () => {
    it('generates a challenge prompt referencing the previous message', () => {
      const previousMsg: CouncilMessage = {
        id: 'msg-1',
        role: 'agent',
        agentId: 'huahua',
        content: 'I think we should use a monorepo because it simplifies dependency management.',
        timestamp: Date.now(),
      };
      const prompt = engine.generateChallengePrompt(previousMsg);
      expect(prompt).toContain('monorepo');
      expect(prompt).toContain('problem');
    });
  });

  describe('classifyResponse', () => {
    it('detects direct disagreement', () => {
      const result = engine.classifyResponse('I disagree with that approach. The real issue is...');
      expect(result).toBe('opposition');
    });

    it('detects conditional agreement', () => {
      const result = engine.classifyResponse('I partially agree, but we need to consider the cost implications.');
      expect(result).toBe('conditional');
    });

    it('detects full agreement', () => {
      const result = engine.classifyResponse('I completely agree. That is exactly right.');
      expect(result).toBe('agreement');
    });
  });

  describe('checkConvergence', () => {
    it('returns null when disagreement rate is healthy', () => {
      engine.recordClassification('opposition');
      engine.recordClassification('conditional');
      engine.recordClassification('opposition');
      const result = engine.checkConvergence();
      expect(result).toBeNull();
    });

    it('returns reinforcement when disagreement rate is too low for consecutive rounds', () => {
      engine.recordClassification('agreement');
      engine.recordClassification('agreement');
      engine.recordClassification('agreement');
      const result = engine.checkConvergence();
      expect(result).not.toBeNull();
      expect(result).toContain('converging');
    });
  });
});
