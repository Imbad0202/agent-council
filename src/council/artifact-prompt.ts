import type { CouncilMessage, ProviderMessage, ChatOptions } from '../types.js';

export type Preset = 'universal' | 'decision';

const UNIVERSAL_SYSTEM = `You are an artifact synthesizer. Read the council deliberation transcript and produce a structured markdown decision memo.

REQUIRED structure (in this exact order, with these exact headings):

## TL;DR

A 2-3 sentence conclusion of the discussion.

## Discussion

Summarize key points raised during deliberation.

## Open questions

List unresolved questions that surfaced.

## Suggested next step

One concrete action to take next.

The ## TL;DR section is mandatory. Output ONLY this markdown — no preamble, no commentary.`;

const DECISION_SYSTEM = `You are an artifact synthesizer. Read the council deliberation transcript and produce a structured decision memo.

REQUIRED structure (in this exact order, with these exact headings):

## TL;DR

A 2-3 sentence conclusion stating the recommended decision.

## Options considered

List the options that were debated.

## Recommended option

State the recommendation and one-line justification.

## Trade-offs

What is sacrificed by the recommendation.

## Suggested next step

One concrete action to take next.

The ## TL;DR section is mandatory. Output ONLY this markdown — no preamble, no commentary.`;

export function buildArtifactPrompt(
  preset: Preset,
  transcript: readonly CouncilMessage[],
  modelName: string,
): { messages: ProviderMessage[]; options: ChatOptions } {
  const systemPrompt = preset === 'decision' ? DECISION_SYSTEM : UNIVERSAL_SYSTEM;
  const transcriptBody = transcript
    .map(t => `[${t.agentId ?? t.role}] ${t.content}`)
    .join('\n\n');

  const messages: ProviderMessage[] = [
    {
      role: 'user',
      content: `Council deliberation transcript:\n\n${transcriptBody}\n\nProduce the artifact now.`,
    },
  ];

  const options: ChatOptions = {
    model: modelName,
    systemPrompt,
    maxTokens: 3000,
    temperature: 0.25,
    // NO systemPromptParts: keeps personality.ts markdown ban OUT of this call.
  };

  return { messages, options };
}

/**
 * Extract the TL;DR content from a synthesizer artifact.
 *
 * Spec §5: regex avoids \Z (not a JS anchor) and the m flag (which would
 * make $ a line-end and stop at the first newline). Uses (?:^|\n) for
 * line-start semantics and bare $ for end-of-string.
 *
 * Heading line allows trailing horizontal whitespace only (`[ \t]*`) — NOT
 * arbitrary `\s*` — because `\s` would absorb the newlines that delimit the
 * heading. A blank separator line (`\n\n+`) is required before the body, and
 * the body's first character must not start another `## ` heading (handled by
 * the `(?!## )` negative lookahead). Together these reject a TL;DR section
 * that has no body — extra blank lines would otherwise let the following
 * section's content false-positive match as TL;DR body.
 */
const TLDR_RE = /(?:^|\n)## TL;DR[ \t]*\n\n+(?!## )([^\n][\s\S]*?)(?=\n## |$)/;

export function parseArtifact(content: string): { tldr: string | null } {
  const m = content.match(TLDR_RE);
  if (!m) return { tldr: null };
  return { tldr: m[1].trim() };
}
