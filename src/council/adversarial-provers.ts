// src/council/adversarial-provers.ts
/**
 * PVG adversarial-prover family.
 *
 * Four orthogonal failure-mode vectors, each with its own trailer format:
 *  - sneaky-prover      → factual error (trailer/helpers live in sneaky-prover.ts)
 *  - biased-prover      → cognitive-bias framing
 *  - deceptive-prover   → conclusion/evidence mismatch
 *  - calibrated-prover  → honest response with declared confidence + unknown
 *
 * Trailers are parsed and STRIPPED before broadcast so other agents never
 * see the answer key. Only the user receives the end-of-round debrief.
 *
 * Framework reference: Kirchner et al. 2024, Prover-Verifier Games
 * (arxiv 2407.13692).
 */

import {
  SNEAKY_TRAILER_PREFIX,
  parseSneakyTrailer,
  escapeRegex,
} from './sneaky-prover.js';
import type { AgentRole } from '../types.js';

export const BIASED_TRAILER_PREFIX = '<<<BIASED-PROVER:';
export const DECEPTIVE_TRAILER_PREFIX = '<<<DECEPTIVE-PROVER:';
export const CALIBRATED_TRAILER_PREFIX = '<<<CALIBRATED-PROVER:';

export const BIAS_KINDS = [
  'availability',
  'anchoring',
  'confirmation',
  'sunk-cost',
] as const;
export type BiasKind = (typeof BIAS_KINDS)[number];

export type AdversarialMode = 'biased' | 'deceptive' | 'calibrated';

export const ADVERSARIAL_MODE_TO_ROLE: Record<AdversarialMode, AgentRole> = {
  biased: 'biased-prover',
  deceptive: 'deceptive-prover',
  calibrated: 'calibrated-prover',
};

export interface BiasedTrailer {
  kind: BiasKind;
  debrief: string;
  bodyWithoutTrailer: string;
}

export interface DeceptiveTrailer {
  debrief: string;
  bodyWithoutTrailer: string;
}

export interface CalibratedTrailer {
  confidence: number;
  unknown: string;
  bodyWithoutTrailer: string;
}

const BIASED_REGEX = new RegExp(
  `^${escapeRegex(BIASED_TRAILER_PREFIX)}([a-z-]+)\\|([^>]+)>>>\\s*$`,
  'm',
);
const DECEPTIVE_REGEX = new RegExp(
  `^${escapeRegex(DECEPTIVE_TRAILER_PREFIX)}([^>]+)>>>\\s*$`,
  'm',
);
const CALIBRATED_REGEX = new RegExp(
  `^${escapeRegex(CALIBRATED_TRAILER_PREFIX)}([0-9.]+)\\|([^>]+)>>>\\s*$`,
  'm',
);

function isBiasKind(value: string): value is BiasKind {
  return (BIAS_KINDS as readonly string[]).includes(value);
}

export function parseBiasedTrailer(content: string): BiasedTrailer | null {
  const match = content.match(BIASED_REGEX);
  if (!match) return null;
  const kind = match[1];
  if (!isBiasKind(kind)) return null;
  return {
    kind,
    debrief: match[2].trim(),
    bodyWithoutTrailer: content.replace(BIASED_REGEX, '').trimEnd(),
  };
}

export function parseDeceptiveTrailer(content: string): DeceptiveTrailer | null {
  const match = content.match(DECEPTIVE_REGEX);
  if (!match) return null;
  return {
    debrief: match[1].trim(),
    bodyWithoutTrailer: content.replace(DECEPTIVE_REGEX, '').trimEnd(),
  };
}

export function parseCalibratedTrailer(content: string): CalibratedTrailer | null {
  const match = content.match(CALIBRATED_REGEX);
  if (!match) return null;
  const confidence = Number(match[1]);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return null;
  }
  return {
    confidence,
    unknown: match[2].trim(),
    bodyWithoutTrailer: content.replace(CALIBRATED_REGEX, '').trimEnd(),
  };
}

export type AdversarialRole =
  | 'sneaky-prover'
  | 'biased-prover'
  | 'deceptive-prover'
  | 'calibrated-prover';

export const ADVERSARIAL_ROLES: AdversarialRole[] = [
  'sneaky-prover',
  'biased-prover',
  'deceptive-prover',
  'calibrated-prover',
];

export function isAdversarialRole(role: string): role is AdversarialRole {
  return (ADVERSARIAL_ROLES as string[]).includes(role);
}

export interface AdversarialDebriefRecord {
  role: AdversarialRole;
  agentId: string;
  debrief: string;
  kind?: string;
  confidence?: number;
}

export function formatAdversarialDebrief(record: AdversarialDebriefRecord): string {
  switch (record.role) {
    case 'sneaky-prover':
      return `🔒 [SNEAKY DEBRIEF] ${record.agentId} planted ${record.kind ?? 'unknown'}: ${record.debrief}`;
    case 'biased-prover':
      return `🎯 [BIASED DEBRIEF] ${record.agentId} framed with ${record.kind ?? 'unknown'} bias: ${record.debrief}`;
    case 'deceptive-prover':
      return `🎭 [DECEPTIVE DEBRIEF] ${record.agentId} conclusion-evidence mismatch: ${record.debrief}`;
    case 'calibrated-prover':
      return `📐 [CALIBRATED DEBRIEF] ${record.agentId} confidence=${record.confidence ?? 'n/a'}: ${record.debrief}`;
  }
}

export interface AdversarialDispatchResult {
  storedContent: string;
  debrief: AdversarialDebriefRecord | null;
}

export function processAdversarialResponse(
  role: string,
  agentId: string,
  content: string,
): AdversarialDispatchResult {
  if (role === 'sneaky-prover') {
    const parsed = parseSneakyTrailer(content);
    if (parsed) {
      return {
        storedContent: parsed.bodyWithoutTrailer,
        debrief: { role: 'sneaky-prover', agentId, kind: parsed.kind, debrief: parsed.debrief },
      };
    }
    return {
      storedContent: content,
      debrief: {
        role: 'sneaky-prover',
        agentId,
        kind: 'missing-trailer',
        debrief: 'Sneaky-prover response had no trailer; planted error not declared',
      },
    };
  }
  if (role === 'biased-prover') {
    const parsed = parseBiasedTrailer(content);
    if (parsed) {
      return {
        storedContent: parsed.bodyWithoutTrailer,
        debrief: {
          role: 'biased-prover',
          agentId,
          kind: parsed.kind,
          debrief: parsed.debrief,
        },
      };
    }
    return {
      storedContent: content,
      debrief: {
        role: 'biased-prover',
        agentId,
        debrief: 'Biased-prover response had missing trailer; bias vector not declared',
      },
    };
  }
  if (role === 'deceptive-prover') {
    const parsed = parseDeceptiveTrailer(content);
    if (parsed) {
      return {
        storedContent: parsed.bodyWithoutTrailer,
        debrief: { role: 'deceptive-prover', agentId, debrief: parsed.debrief },
      };
    }
    return {
      storedContent: content,
      debrief: {
        role: 'deceptive-prover',
        agentId,
        debrief: 'Deceptive-prover response had missing trailer; mismatch not declared',
      },
    };
  }
  if (role === 'calibrated-prover') {
    const parsed = parseCalibratedTrailer(content);
    if (parsed) {
      return {
        storedContent: parsed.bodyWithoutTrailer,
        debrief: {
          role: 'calibrated-prover',
          agentId,
          confidence: parsed.confidence,
          debrief: parsed.unknown,
        },
      };
    }
    return {
      storedContent: content,
      debrief: {
        role: 'calibrated-prover',
        agentId,
        debrief: 'Calibrated-prover response had missing trailer; confidence/unknown not declared',
      },
    };
  }
  return { storedContent: content, debrief: null };
}
