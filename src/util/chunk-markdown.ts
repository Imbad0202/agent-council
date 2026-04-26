/**
 * Split a string into chunks no longer than maxChars each.
 *
 * Algorithm priority:
 *   1. If text fits → return [text].
 *   2. Try paragraph boundary (\n\n) at or before maxChars.
 *   3. Else try last whitespace at or before maxChars.
 *   4. Else hard split at exactly maxChars.
 *
 * Empty input returns [] (NOT [''])
 */
export function chunkMarkdown(text: string, maxChars: number): string[] {
  if (maxChars <= 0) throw new RangeError('maxChars must be positive');
  if (text.length === 0) return [];
  if (text.length <= maxChars) return [text];

  const paraIdx = text.lastIndexOf('\n\n', maxChars);
  if (paraIdx >= 0) {
    const head = text.slice(0, paraIdx);
    const tail = text.slice(paraIdx + 2);
    if (head.length > 0) return [head, ...chunkMarkdown(tail, maxChars)];
    // paraIdx === 0: leading \n\n — skip the separator, recurse on remainder
    return chunkMarkdown(tail, maxChars);
  }

  // Last whitespace in the window: \s where only non-whitespace follows to end
  const lastWsMatch = text.slice(0, maxChars).match(/\s(?=\S*$)/);
  if (lastWsMatch && lastWsMatch.index !== undefined && lastWsMatch.index > 0) {
    const splitAt = lastWsMatch.index;
    const head = text.slice(0, splitAt);
    const tail = text.slice(splitAt + 1);
    return [head, ...chunkMarkdown(tail, maxChars)];
  }

  const head = text.slice(0, maxChars);
  const tail = text.slice(maxChars);
  return [head, ...chunkMarkdown(tail, maxChars)];
}
