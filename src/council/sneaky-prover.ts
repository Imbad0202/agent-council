// src/council/sneaky-prover.ts
/**
 * SneakyProver helpers — trailer parsing, debrief formatting, target selection.
 *
 * Inspired by Kirchner et al. 2024 (Prover-Verifier Games). The trailer
 * format is parsed out before broadcast so other agents never see the
 * planted-error answer key; only the user receives the end-of-round
 * debrief.
 */

export const SNEAKY_TRAILER_PREFIX = '<<<SNEAKY-PROVER:';
const TRAILER_REGEX = new RegExp(`^${SNEAKY_TRAILER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([a-z-]+)\\|([^>]+)>>>\\s*$`, 'm');

export interface ParsedTrailer {
  kind: string;
  debrief: string;
  bodyWithoutTrailer: string;
}

export interface DebriefRecord {
  agentId: string;
  kind: string;
  debrief: string;
}

export function parseSneakyTrailer(content: string): ParsedTrailer | null {
  const match = content.match(TRAILER_REGEX);
  if (!match) return null;
  return {
    kind: match[1],
    debrief: match[2].trim(),
    bodyWithoutTrailer: content.replace(TRAILER_REGEX, '').trimEnd(),
  };
}

export function formatDebrief(record: DebriefRecord): string {
  return `🔒 [SNEAKY DEBRIEF] ${record.agentId} planted ${record.kind}: ${record.debrief}`;
}

/**
 * Pick which agent gets the sneaky-prover role this round.
 *
 * RNG is injectable so tests can deterministically pick first or last
 * agent. Production callers use the default Math.random.
 */
export function pickSneakyTarget(
  agentIds: string[],
  rng: () => number = Math.random,
): string {
  if (agentIds.length === 0) {
    throw new Error('pickSneakyTarget requires at least one agent');
  }
  const idx = Math.floor(rng() * agentIds.length);
  return agentIds[Math.min(idx, agentIds.length - 1)];
}
