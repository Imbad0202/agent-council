import { describe, it, expect } from 'vitest';
import { buildArtifactPrompt, parseArtifact } from '../../src/council/artifact-prompt.js';
import type { CouncilMessage } from '../../src/types.js';

const TURN = (content: string): CouncilMessage => ({
  id: 'test-id',
  role: 'agent',
  agentId: 'agent-alpha',
  content,
  timestamp: Date.now(),
});

describe('buildArtifactPrompt', () => {
  it('returns messages and options without systemPromptParts (bypasses personality ban)', () => {
    const { options } = buildArtifactPrompt('universal', [TURN('hello')], 'claude-sonnet-4-5');
    expect(options.systemPromptParts).toBeUndefined();
  });

  it('universal preset: systemPrompt includes required headings', () => {
    const { options } = buildArtifactPrompt('universal', [TURN('hello')], 'claude-sonnet-4-5');
    expect(options.systemPrompt).toContain('## Discussion');
    expect(options.systemPrompt).toContain('## Open questions');
    expect(options.systemPrompt).toContain('## Suggested next step');
  });

  it('decision preset: systemPrompt includes required headings', () => {
    const { options } = buildArtifactPrompt('decision', [TURN('hello')], 'claude-sonnet-4-5');
    expect(options.systemPrompt).toContain('## Options considered');
    expect(options.systemPrompt).toContain('## Recommended option');
    expect(options.systemPrompt).toContain('## Trade-offs');
    expect(options.systemPrompt).toContain('## Suggested next step');
  });

  it('temperature is between 0.2 and 0.3', () => {
    const { options } = buildArtifactPrompt('universal', [TURN('hello')], 'claude-sonnet-4-5');
    expect(options.temperature).toBeGreaterThanOrEqual(0.2);
    expect(options.temperature).toBeLessThanOrEqual(0.3);
  });

  it('maxTokens === 3000', () => {
    const { options } = buildArtifactPrompt('universal', [TURN('hello')], 'claude-sonnet-4-5');
    expect(options.maxTokens).toBe(3000);
  });

  it('messages array contains the transcript body in a user message', () => {
    const transcript = [TURN('first point'), TURN('second point')];
    const { messages } = buildArtifactPrompt('universal', transcript, 'claude-sonnet-4-5');
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toContain('[agent-alpha] first point');
    expect(messages[0].content).toContain('[agent-alpha] second point');
  });
});

describe('parseArtifact', () => {
  it('extracts TL;DR with another heading following', () => {
    const content = `## TL;DR\n\nThis is the summary.\n\n## Discussion\n\nsome discussion`;
    const { tldr } = parseArtifact(content);
    expect(tldr).toBe('This is the summary.');
  });

  it('extracts TL;DR at end-of-string (no trailing heading)', () => {
    const content = `## TL;DR\n\nThis is a standalone summary.`;
    const { tldr } = parseArtifact(content);
    expect(tldr).toBe('This is a standalone summary.');
  });

  it('TL;DR containing uppercase Z is NOT truncated (regression: no \\Z anchor in JS)', () => {
    const content = `## TL;DR\n\nAmaZing result with Z at the end.\n\n## Discussion\n\ndetails`;
    const { tldr } = parseArtifact(content);
    // Must capture the full sentence, not stop at 'Z'
    expect(tldr).toBe('AmaZing result with Z at the end.');
  });

  it('returns { tldr: null } when ## TL;DR heading is missing', () => {
    const content = `## Discussion\n\nsome discussion without TL;DR`;
    const { tldr } = parseArtifact(content);
    expect(tldr).toBeNull();
  });

  it('matches ## TL;DR at very start (no leading newline)', () => {
    const content = `## TL;DR\n\nImmediate start summary.`;
    const { tldr } = parseArtifact(content);
    expect(tldr).toBe('Immediate start summary.');
  });
});
