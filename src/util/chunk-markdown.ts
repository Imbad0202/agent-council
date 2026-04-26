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
  if (text.length === 0) return [];
  if (text.length <= maxChars) return [text];

  const paraIdx = text.lastIndexOf('\n\n', maxChars);
  if (paraIdx > 0) {
    const head = text.slice(0, paraIdx);
    const tail = text.slice(paraIdx + 2);
    return [head, ...chunkMarkdown(tail, maxChars)];
  }

  const wsMatch = text.slice(0, maxChars).match(/\s(?=\S*$)/);
  if (wsMatch && wsMatch.index !== undefined && wsMatch.index > 0) {
    const splitAt = wsMatch.index;
    const head = text.slice(0, splitAt);
    const tail = text.slice(splitAt + 1);
    return [head, ...chunkMarkdown(tail, maxChars)];
  }

  const head = text.slice(0, maxChars);
  const tail = text.slice(maxChars);
  return [head, ...chunkMarkdown(tail, maxChars)];
}
