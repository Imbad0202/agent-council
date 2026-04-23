import type { ResetSnapshot } from '../types.js';

export interface ResetSummaryPromptInput {
  topic: string;
  turnsInSegment: number;
}

export function buildResetSummaryPrompt(input: ResetSummaryPromptInput): string {
  return [
    `You are closing out a deliberation segment on topic: "${input.topic}" (${input.turnsInSegment} turns).`,
    `Produce a markdown summary with EXACTLY these four H2 sections, in this order:`,
    ``,
    `## Decisions`,
    `One bullet per decision reached. Use "- " prefix. Leave blank if none.`,
    ``,
    `## Open Questions`,
    `One bullet per unresolved question. Use "- " prefix. Leave blank if none.`,
    ``,
    `## Evidence Pointers`,
    `One bullet per citation or prior-turn reference. Use "- " prefix.`,
    ``,
    `## Blind-Review State`,
    `Free text: current agent tier assignments, PVG rotation state, or "none".`,
    ``,
    `Output the markdown only. No preamble, no closing remarks.`,
  ].join('\n');
}

// Max number of prior snapshot summaries to replay to the facilitator on
// /councilreset. Each snapshot already carries forward decisions from its
// predecessors (see buildPriorSummariesBlock), so tail-N gives the same
// semantic content as the full history without the O(n²) token cost of
// replaying every prior reset on every subsequent reset. Tuned at 3 so a
// typical long-running thread still surfaces a shallow decision trail to
// the synthesizer without blowing the facilitator context budget.
const MAX_PRIOR_SUMMARIES_FOR_FACILITATOR = 3;

// Flatten the thread's prior snapshot summaries into a single markdown block
// the facilitator can read as context. Ordering follows segment_index ASC
// (oldest first in the slice window) so "carry-forward" reads
// chronologically. Each prior snapshot is quoted under its own heading so
// the facilitator can cite the specific segment it's preserving decisions
// from.
export function buildPriorSummariesBlock(priorSnapshots: ResetSnapshot[]): string {
  const tail = priorSnapshots.slice(-MAX_PRIOR_SUMMARIES_FOR_FACILITATOR);
  const lines: string[] = [
    '## Prior session segments (carry-forward context)',
    '',
    'The council has already run /councilreset in this thread.',
    'Preserve every decision and open question from the prior segments below',
    'when you produce the new summary — do NOT drop them just because they',
    'are not in the current segment transcript.',
    '',
  ];
  for (const snap of tail) {
    lines.push(`### Segment ${snap.segmentIndex} (sealed ${snap.sealedAt})`);
    lines.push('');
    lines.push(snap.summaryMarkdown);
    lines.push('');
  }
  return lines.join('\n');
}

export interface ParsedSummaryMetadata {
  decisionsCount: number;
  openQuestionsCount: number;
}

// Round-16 codex finding [P2-VALIDATION]: parseSummaryMetadata is
// structural-only — it counts bullets under whichever sections it finds and
// returns 0 for missing sections. That's fine for counting, but it is NOT a
// validity check: a facilitator response with `### Decisions` (wrong
// heading level) or only some sections would still parse as 0/0 and get
// committed. SessionReset calls this validator BEFORE persist so a malformed
// summary throws MalformedResetSummaryError instead of poisoning the
// snapshot DB.
//
// Required sections come from the same buildResetSummaryPrompt prompt —
// keep this list in sync with the prompt's "EXACTLY these four H2
// sections" promise.
export const REQUIRED_RESET_SUMMARY_SECTIONS = [
  'Decisions',
  'Open Questions',
  'Evidence Pointers',
  'Blind-Review State',
] as const;

export interface ResetSummaryValidationResult {
  valid: boolean;
  missingSections: string[];
}

export function validateResetSummaryMarkdown(
  markdown: string,
): ResetSummaryValidationResult {
  const headings = new Set<string>();
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('## ') && !line.startsWith('### ')) {
      headings.add(line.slice(3).toLowerCase());
    }
  }
  const missing = REQUIRED_RESET_SUMMARY_SECTIONS.filter(
    (section) => !headings.has(section.toLowerCase()),
  );
  return { valid: missing.length === 0, missingSections: missing };
}

export function parseSummaryMetadata(markdown: string): ParsedSummaryMetadata {
  const lines = markdown.split('\n');
  let section: 'decisions' | 'open' | 'other' = 'other';
  let decisionsCount = 0;
  let openQuestionsCount = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('## ')) {
      const header = line.slice(3).toLowerCase();
      if (header === 'decisions') section = 'decisions';
      else if (header === 'open questions') section = 'open';
      else section = 'other';
      continue;
    }
    if (line.startsWith('- ') && line.length > 2) {
      if (section === 'decisions') decisionsCount += 1;
      else if (section === 'open') openQuestionsCount += 1;
    }
  }

  return { decisionsCount, openQuestionsCount };
}
