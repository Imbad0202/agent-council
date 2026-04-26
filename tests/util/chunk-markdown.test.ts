import { describe, it, expect } from 'vitest';
import { chunkMarkdown } from '../../src/util/chunk-markdown.js';

describe('chunkMarkdown', () => {
  it('returns [] for empty string', () => {
    expect(chunkMarkdown('', 4096)).toEqual([]);
  });

  it('returns single chunk when text fits in maxChars', () => {
    const text = 'a'.repeat(4096);
    expect(chunkMarkdown(text, 4096)).toEqual([text]);
  });

  it('splits at paragraph boundary when available within maxChars', () => {
    const para1 = 'a'.repeat(3000);
    const para2 = 'b'.repeat(2000);
    const result = chunkMarkdown(`${para1}\n\n${para2}`, 4096);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(para1);
    expect(result[1]).toBe(para2);
  });

  it('splits at last whitespace within maxChars when no paragraph boundary', () => {
    const text = 'word '.repeat(1000); // 5000 chars, no \n\n, plenty of spaces
    const result = chunkMarkdown(text, 4096);
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.every(chunk => chunk.length <= 4096)).toBe(true);
  });

  it('hard-splits mid-token at exactly maxChars when no whitespace', () => {
    const text = 'a'.repeat(5000);
    const result = chunkMarkdown(text, 4096);
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(4096);
    expect(result[1]).toHaveLength(904);
    expect(result[0] + result[1]).toBe(text);
  });

  it('every chunk satisfies length <= maxChars invariant', () => {
    const text = 'x'.repeat(50_000);
    const result = chunkMarkdown(text, 4096);
    for (const chunk of result) expect(chunk.length).toBeLessThanOrEqual(4096);
  });
});
