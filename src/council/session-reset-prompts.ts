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

export interface ParsedSummaryMetadata {
  decisionsCount: number;
  openQuestionsCount: number;
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
