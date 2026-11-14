/**
 * Edge trimming that keeps a message's own whitespace.
 *
 * `String.prototype.trim()` also removes the indentation of the first line, which
 * changes what a pasted prompt or an indented code answer means. Only entirely
 * blank lines at the start, and trailing space at the end, are not content.
 */
export function trimBlankEdges(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/^(?:[ \t\u00a0]*\n)+/, '')
    .replace(/[\s\u00a0]+$/, '');
}
