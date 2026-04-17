// tests/council/adversarial-provers.test.ts
//
// PVG (Prover-Verifier Games) extension: biased-prover, deceptive-prover, calibrated-prover.
// Each extends the sneaky-prover pattern with a distinct failure-mode vector.
import { describe, it, expect } from 'vitest';
import { ROLE_DIRECTIVES_INTERNAL } from '../../src/worker/personality.js';
import {
  BIASED_TRAILER_PREFIX,
  DECEPTIVE_TRAILER_PREFIX,
  CALIBRATED_TRAILER_PREFIX,
  parseBiasedTrailer,
  parseDeceptiveTrailer,
  parseCalibratedTrailer,
  formatAdversarialDebrief,
  BIAS_KINDS,
  type BiasKind,
} from '../../src/council/adversarial-provers.js';
import { assignRoles } from '../../src/council/role-assigner.js';
import type { CouncilConfig, AgentRole } from '../../src/types.js';

const baseConfig: CouncilConfig = {
  roles: {
    default2Agents: ['advocate', 'critic'],
    topicOverrides: {},
  },
  antiSycophancy: { enabled: false, maxConsecutiveAgreements: 3 },
} as unknown as CouncilConfig;

describe('biased-prover role', () => {
  it('ROLE_DIRECTIVES has biased-prover entry with IRON RULE and trailer marker', () => {
    const directive = ROLE_DIRECTIVES_INTERNAL['biased-prover'];
    expect(directive).toBeDefined();
    expect(directive).toContain('IRON RULE');
    expect(directive).toContain(BIASED_TRAILER_PREFIX);
  });

  it('directive enumerates the four bias kinds', () => {
    const directive = ROLE_DIRECTIVES_INTERNAL['biased-prover'];
    for (const kind of BIAS_KINDS) {
      expect(directive).toContain(kind);
    }
  });

  it('parseBiasedTrailer extracts kind, debrief, and stripped body', () => {
    const content = `My analysis of the startup's prospects.

Given that three of my last four successful investments were in B2B SaaS, I estimate this B2B SaaS deal has a 75% success probability.

<<<BIASED-PROVER:availability|Used my own recent wins as base rate instead of actual SaaS success rates>>>`;
    const parsed = parseBiasedTrailer(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe('availability');
    expect(parsed!.debrief).toBe(
      'Used my own recent wins as base rate instead of actual SaaS success rates',
    );
    expect(parsed!.bodyWithoutTrailer).toContain('My analysis');
    expect(parsed!.bodyWithoutTrailer).not.toContain(BIASED_TRAILER_PREFIX);
  });

  it('parseBiasedTrailer rejects unknown bias kinds', () => {
    const content = `Body.

<<<BIASED-PROVER:not-a-real-bias|whatever>>>`;
    expect(parseBiasedTrailer(content)).toBeNull();
  });

  it('parseBiasedTrailer returns null when trailer absent', () => {
    expect(parseBiasedTrailer('Just a normal response.')).toBeNull();
  });

  it('accepts all four enumerated bias kinds', () => {
    const kinds: BiasKind[] = ['availability', 'anchoring', 'confirmation', 'sunk-cost'];
    for (const kind of kinds) {
      const content = `Body.\n\n<<<BIASED-PROVER:${kind}|debrief text>>>`;
      expect(parseBiasedTrailer(content)?.kind).toBe(kind);
    }
  });
});

describe('deceptive-prover role', () => {
  it('ROLE_DIRECTIVES has deceptive-prover entry with IRON RULE and trailer marker', () => {
    const directive = ROLE_DIRECTIVES_INTERNAL['deceptive-prover'];
    expect(directive).toBeDefined();
    expect(directive).toContain('IRON RULE');
    expect(directive).toContain(DECEPTIVE_TRAILER_PREFIX);
  });

  it('directive requires conclusion-evidence mismatch (not factual-error)', () => {
    const directive = ROLE_DIRECTIVES_INTERNAL['deceptive-prover'];
    // It must specify the conclusion-evidence gap pattern
    expect(directive.toLowerCase()).toMatch(/conclusion|evidence/);
    // Must NOT be a synonym of sneaky-prover (no invented facts)
    expect(directive).toContain(DECEPTIVE_TRAILER_PREFIX);
  });

  it('parseDeceptiveTrailer extracts stated claim, actual support, and stripped body', () => {
    const content = `Analysis of the new pricing model.

Studies show tiered pricing increases conversion by ~8% in consumer SaaS. The cited effect is modest and context-dependent. Therefore we should adopt tiered pricing immediately across all product lines — this will clearly drive major revenue growth.

<<<DECEPTIVE-PROVER:Evidence supports "modest 8% effect in consumer SaaS" but conclusion jumps to "clear major growth across all product lines">>>`;
    const parsed = parseDeceptiveTrailer(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.debrief).toContain('modest 8%');
    expect(parsed!.bodyWithoutTrailer).toContain('Analysis of the new pricing model.');
    expect(parsed!.bodyWithoutTrailer).not.toContain(DECEPTIVE_TRAILER_PREFIX);
  });

  it('parseDeceptiveTrailer returns null when trailer absent', () => {
    expect(parseDeceptiveTrailer('Just a response.')).toBeNull();
  });
});

describe('calibrated-prover role', () => {
  it('ROLE_DIRECTIVES has calibrated-prover entry with IRON RULE and trailer marker', () => {
    const directive = ROLE_DIRECTIVES_INTERNAL['calibrated-prover'];
    expect(directive).toBeDefined();
    expect(directive).toContain('IRON RULE');
    expect(directive).toContain(CALIBRATED_TRAILER_PREFIX);
  });

  it('directive requires explicit confidence + at least one declared unknown', () => {
    const directive = ROLE_DIRECTIVES_INTERNAL['calibrated-prover'];
    expect(directive.toLowerCase()).toContain('confidence');
    expect(directive.toLowerCase()).toMatch(/unknown|uncertain/);
  });

  it('parseCalibratedTrailer extracts confidence (0-1) and unknown', () => {
    const content = `My read on whether to ship the migration this week.

Given the test coverage on the auth module and the low traffic window, I'd say shipping is reasonable. I have not verified the rollback path end-to-end.

<<<CALIBRATED-PROVER:0.65|Unverified: rollback path has not been exercised end-to-end in staging>>>`;
    const parsed = parseCalibratedTrailer(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.confidence).toBeCloseTo(0.65);
    expect(parsed!.unknown).toContain('rollback path');
    expect(parsed!.bodyWithoutTrailer).toContain('My read');
    expect(parsed!.bodyWithoutTrailer).not.toContain(CALIBRATED_TRAILER_PREFIX);
  });

  it('parseCalibratedTrailer rejects confidence outside [0,1]', () => {
    const tooHigh = `Body.\n\n<<<CALIBRATED-PROVER:1.5|unknown>>>`;
    const negative = `Body.\n\n<<<CALIBRATED-PROVER:-0.1|unknown>>>`;
    expect(parseCalibratedTrailer(tooHigh)).toBeNull();
    expect(parseCalibratedTrailer(negative)).toBeNull();
  });

  it('parseCalibratedTrailer returns null when trailer absent', () => {
    expect(parseCalibratedTrailer('No trailer here.')).toBeNull();
  });
});

describe('formatAdversarialDebrief', () => {
  it('renders biased-prover debrief with agent + bias kind + explanation', () => {
    const out = formatAdversarialDebrief({
      role: 'biased-prover',
      agentId: 'agent-y',
      kind: 'confirmation',
      debrief: 'Only cited sources that agreed with the pre-stated conclusion',
    });
    expect(out).toContain('BIASED DEBRIEF');
    expect(out).toContain('agent-y');
    expect(out).toContain('confirmation');
    expect(out).toContain('Only cited sources');
  });

  it('renders deceptive-prover debrief', () => {
    const out = formatAdversarialDebrief({
      role: 'deceptive-prover',
      agentId: 'agent-z',
      debrief: 'Conclusion overstates the cited evidence magnitude',
    });
    expect(out).toContain('DECEPTIVE DEBRIEF');
    expect(out).toContain('agent-z');
    expect(out).toContain('overstates');
  });

  it('renders calibrated-prover debrief with confidence', () => {
    const out = formatAdversarialDebrief({
      role: 'calibrated-prover',
      agentId: 'agent-w',
      confidence: 0.4,
      debrief: 'Key unknown: has not verified migration on production replica',
    });
    expect(out).toContain('CALIBRATED DEBRIEF');
    expect(out).toContain('agent-w');
    expect(out).toContain('0.4');
    expect(out).toContain('Key unknown');
  });
});

describe('role-assigner opt-in guards for new adversarial roles', () => {
  const adversarialRoles: AgentRole[] = [
    'biased-prover',
    'deceptive-prover',
    'calibrated-prover',
  ];

  it('default role assignment excludes all three new adversarial roles', () => {
    const assignments = assignRoles(['a1', 'a2'], 'normal message', baseConfig);
    for (const role of adversarialRoles) {
      expect(Object.values(assignments)).not.toContain(role);
    }
  });

  it.each(adversarialRoles)(
    'assignRoles throws when %s requested without allowAdversarial',
    (role) => {
      const cfg: CouncilConfig = {
        ...baseConfig,
        roles: {
          ...baseConfig.roles,
          topicOverrides: { testing: [role, 'critic'] },
        },
      } as CouncilConfig;
      expect(() =>
        assignRoles(['a1', 'a2'], 'run qa regression integration tests', cfg),
      ).toThrow(new RegExp(`${role}.*allowAdversarial`, 'i'));
    },
  );

  it.each(adversarialRoles)(
    'assignRoles allows %s when allowAdversarial=true',
    (role) => {
      const cfg: CouncilConfig = {
        ...baseConfig,
        roles: {
          ...baseConfig.roles,
          topicOverrides: { testing: [role, 'critic'] },
        },
      } as CouncilConfig;
      expect(() =>
        assignRoles(
          ['a1', 'a2'],
          'run qa regression integration tests',
          cfg,
          undefined,
          { allowAdversarial: true },
        ),
      ).not.toThrow();
    },
  );
});

describe('processAdversarialResponse dispatcher', () => {
  // Dispatcher is used by deliberation.ts to strip any adversarial trailer
  // and emit a debrief record, without the deliberation loop needing to
  // know the details of each role.
  it('routes biased-prover role to the biased parser', async () => {
    const { processAdversarialResponse } = await import(
      '../../src/council/adversarial-provers.js'
    );
    const content = `Body.\n\n<<<BIASED-PROVER:anchoring|Anchored on first estimate>>>`;
    const result = processAdversarialResponse('biased-prover', 'agent-a', content);
    expect(result.storedContent).not.toContain('<<<');
    expect(result.debrief).not.toBeNull();
    expect(result.debrief!.role).toBe('biased-prover');
    expect(result.debrief!.kind).toBe('anchoring');
  });

  it('routes deceptive-prover role to the deceptive parser', async () => {
    const { processAdversarialResponse } = await import(
      '../../src/council/adversarial-provers.js'
    );
    const content = `Body.\n\n<<<DECEPTIVE-PROVER:Overstated 5% effect>>>`;
    const result = processAdversarialResponse('deceptive-prover', 'agent-b', content);
    expect(result.storedContent).not.toContain('<<<');
    expect(result.debrief!.role).toBe('deceptive-prover');
    expect(result.debrief!.debrief).toContain('Overstated');
  });

  it('routes calibrated-prover role to the calibrated parser', async () => {
    const { processAdversarialResponse } = await import(
      '../../src/council/adversarial-provers.js'
    );
    const content = `Body.\n\n<<<CALIBRATED-PROVER:0.7|Unverified: staging rollback>>>`;
    const result = processAdversarialResponse('calibrated-prover', 'agent-c', content);
    expect(result.storedContent).not.toContain('<<<');
    expect(result.debrief!.role).toBe('calibrated-prover');
    expect(result.debrief!.confidence).toBeCloseTo(0.7);
  });

  it('records a missing-trailer debrief when the adversarial agent omits its trailer', async () => {
    const { processAdversarialResponse } = await import(
      '../../src/council/adversarial-provers.js'
    );
    const content = `Body with no trailer.`;
    const result = processAdversarialResponse('biased-prover', 'agent-d', content);
    expect(result.storedContent).toBe(content);
    expect(result.debrief!.role).toBe('biased-prover');
    expect(result.debrief!.debrief.toLowerCase()).toContain('missing');
  });

  it('routes sneaky-prover through the same unified dispatcher', async () => {
    const { processAdversarialResponse } = await import(
      '../../src/council/adversarial-provers.js'
    );
    const content = `Body.\n\n<<<SNEAKY-PROVER:logical-fallacy|False dichotomy planted>>>`;
    const result = processAdversarialResponse('sneaky-prover', 'agent-s', content);
    expect(result.storedContent).not.toContain('<<<');
    expect(result.debrief!.role).toBe('sneaky-prover');
    expect(result.debrief!.kind).toBe('logical-fallacy');
  });

  it('returns null debrief + untouched content for non-adversarial roles', async () => {
    const { processAdversarialResponse } = await import(
      '../../src/council/adversarial-provers.js'
    );
    const content = `Just a regular critic response.`;
    const result = processAdversarialResponse('critic', 'agent-e', content);
    expect(result.storedContent).toBe(content);
    expect(result.debrief).toBeNull();
  });
});

describe('trailer stripping (storage shape) for all three roles', () => {
  it('biased-prover trailer strips cleanly from storage content', () => {
    const original = `Body.\n\n<<<BIASED-PROVER:anchoring|Anchored on the first revenue estimate>>>`;
    const parsed = parseBiasedTrailer(original);
    expect(parsed).not.toBeNull();
    expect(parsed!.bodyWithoutTrailer).not.toContain(BIASED_TRAILER_PREFIX);
    expect(parsed!.bodyWithoutTrailer).not.toContain('anchoring');
  });

  it('deceptive-prover trailer strips cleanly from storage content', () => {
    const original = `Body.\n\n<<<DECEPTIVE-PROVER:Overstated a 5% effect as "transformative">>>`;
    const parsed = parseDeceptiveTrailer(original);
    expect(parsed).not.toBeNull();
    expect(parsed!.bodyWithoutTrailer).not.toContain(DECEPTIVE_TRAILER_PREFIX);
    expect(parsed!.bodyWithoutTrailer).not.toContain('Overstated');
  });

  it('calibrated-prover trailer strips cleanly from storage content', () => {
    const original = `Body.\n\n<<<CALIBRATED-PROVER:0.5|Did not verify dependency upgrade>>>`;
    const parsed = parseCalibratedTrailer(original);
    expect(parsed).not.toBeNull();
    expect(parsed!.bodyWithoutTrailer).not.toContain(CALIBRATED_TRAILER_PREFIX);
    expect(parsed!.bodyWithoutTrailer).not.toContain('0.5');
  });
});
