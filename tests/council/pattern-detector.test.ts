import { describe, it, expect, beforeEach } from 'vitest';
import { PatternDetector } from '../../src/council/pattern-detector.js';
import type { AntiPatternConfig, LLMProvider, ProviderMessage, ChatOptions } from '../../src/types.js';

const config: AntiPatternConfig = {
  enabled: true,
  detectionModel: 'mock-model',
  startAfterTurn: 3,
  detectEveryNTurns: 2,
};

function createMockProvider(responseContent: string): LLMProvider {
  return {
    name: 'mock',
    async chat(_messages: ProviderMessage[], _options: ChatOptions) {
      return {
        content: responseContent,
        tokensUsed: { input: 0, output: 0 },
      };
    },
    async summarize(_text: string, _model: string) {
      return '';
    },
    estimateTokens(_messages: ProviderMessage[]) {
      return 0;
    },
  };
}

describe('PatternDetector', () => {
  let detector: PatternDetector;
  let mockProvider: LLMProvider;

  beforeEach(() => {
    mockProvider = createMockProvider('{"pattern": null, "target_agent": null}');
    detector = new PatternDetector(config, mockProvider);
  });

  describe('shouldDetect', () => {
    it('skips before startAfterTurn', () => {
      expect(detector.shouldDetect(2)).toBe(false);
    });

    it('detects on correct intervals', () => {
      // startAfterTurn=3, detectEveryNTurns=2
      // turn 4: 4 >= 3 and 4 % 2 === 0 → true
      expect(detector.shouldDetect(4)).toBe(true);
      // turn 5: 5 >= 3 and 5 % 2 === 1 → false
      expect(detector.shouldDetect(5)).toBe(false);
      // turn 6: 6 >= 3 and 6 % 2 === 0 → true
      expect(detector.shouldDetect(6)).toBe(true);
    });
  });

  describe('detect', () => {
    it('finds a pattern when provider detects one', async () => {
      const provider = createMockProvider('{"pattern": "mirror", "target_agent": "binbin"}');
      const det = new PatternDetector(config, provider);

      const result = await det.detect([
        { id: '1', role: 'agent', agentId: 'huahua', content: 'We should use TypeScript.', timestamp: 1 },
        { id: '2', role: 'agent', agentId: 'binbin', content: 'I agree, TypeScript is the way to go.', timestamp: 2 },
      ]);

      expect(result).toEqual({ pattern: 'mirror', targetAgent: 'binbin' });
    });

    it('returns null when no pattern is detected', async () => {
      const provider = createMockProvider('{"pattern": null, "target_agent": null}');
      const det = new PatternDetector(config, provider);

      const result = await det.detect([
        { id: '1', role: 'agent', agentId: 'huahua', content: 'We should use TypeScript.', timestamp: 1 },
        { id: '2', role: 'agent', agentId: 'binbin', content: 'I prefer Rust for this use case.', timestamp: 2 },
      ]);

      expect(result).toBeNull();
    });
  });

  describe('getInjectionPrompt', () => {
    it('returns correct Chinese prompts for each pattern type', () => {
      expect(detector.getInjectionPrompt('mirror')).toContain('重疊');
      expect(detector.getInjectionPrompt('fake_dissent')).toContain('結論一致');
      expect(detector.getInjectionPrompt('quick_surrender')).toContain('改變立場');
      expect(detector.getInjectionPrompt('authority_submission')).toContain('人類');
    });
  });
});
