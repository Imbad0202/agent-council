import { describe, it, expect } from 'vitest';
import {
  buildResetSummaryPrompt,
  parseSummaryMetadata,
} from '../../src/council/session-reset-prompts.js';

describe('buildResetSummaryPrompt', () => {
  it('includes the four fixed section headers', () => {
    const p = buildResetSummaryPrompt({ topic: 'rust vs go', turnsInSegment: 12 });
    expect(p).toContain('## Decisions');
    expect(p).toContain('## Open Questions');
    expect(p).toContain('## Evidence Pointers');
    expect(p).toContain('## Blind-Review State');
    expect(p).toContain('rust vs go');
  });

  it('produces byte-identical output for same input (determinism check)', () => {
    const a = buildResetSummaryPrompt({ topic: 'x', turnsInSegment: 5 });
    const b = buildResetSummaryPrompt({ topic: 'x', turnsInSegment: 5 });
    expect(a).toBe(b);
  });
});

describe('parseSummaryMetadata', () => {
  it('counts bullet lines under Decisions and Open Questions', () => {
    const md = [
      '## Decisions',
      '- ship rust',
      '- defer go',
      '',
      '## Open Questions',
      '- benchmark coverage',
      '',
      '## Evidence Pointers',
      '- turn 4',
      '',
      '## Blind-Review State',
      'none',
    ].join('\n');
    const m = parseSummaryMetadata(md);
    expect(m.decisionsCount).toBe(2);
    expect(m.openQuestionsCount).toBe(1);
  });

  it('returns zeros when sections are empty', () => {
    expect(parseSummaryMetadata('## Decisions\n\n## Open Questions\n')).toEqual({
      decisionsCount: 0,
      openQuestionsCount: 0,
    });
  });

  it('ignores bullets in other sections', () => {
    const md = [
      '## Decisions',
      '- one',
      '## Open Questions',
      '## Evidence Pointers',
      '- not counted',
      '- also not',
    ].join('\n');
    const m = parseSummaryMetadata(md);
    expect(m.decisionsCount).toBe(1);
    expect(m.openQuestionsCount).toBe(0);
  });

  it('ignores malformed bullets (no space after dash)', () => {
    const md = '## Decisions\n-noSpace\n- real one';
    expect(parseSummaryMetadata(md).decisionsCount).toBe(1);
  });
});
