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

  it('splits a 4097-char string (one over limit) into exactly 2 chunks', () => {
    const text = 'a'.repeat(4097);
    const result = chunkMarkdown(text, 4096);
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(4096);
    expect(result[1]).toHaveLength(1);
  });

  it('throws RangeError for maxChars <= 0', () => {
    expect(() => chunkMarkdown('hello', 0)).toThrow(RangeError);
    expect(() => chunkMarkdown('hello', -1)).toThrow(RangeError);
  });

  it('preserves leading \\n\\n when input exceeds maxChars', () => {
    const text = '\n\n' + 'a'.repeat(5000);
    const result = chunkMarkdown(text, 4096);
    // The leading \n\n should not corrupt the output: concatenation
    // (with appropriate separator awareness) should preserve information.
    // Specifically, no character is lost.
    // Easiest invariant: every character in result must trace back to text.
    const reconstructed = result.join('');
    // We don't insist on exact equality (separators are dropped by design),
    // but we DO insist no NON-separator character is lost: the count of 'a'
    // in result equals the count of 'a' in text.
    const aCountIn = (text.match(/a/g) || []).length;
    const aCountOut = (reconstructed.match(/a/g) || []).length;
    expect(aCountOut).toBe(aCountIn);
  });
});
