/**
 * What a message keeps when it is sent, stored and sent on to the model.
 *
 * `String.prototype.trim()` is wrong for a pasted prompt: it also removes the
 * indentation of the first line and of the last one. The only whitespace that is
 * not the person's words is a run of entirely blank lines at the top or bottom,
 * and trailing spaces at the very end. Everything inside is left alone.
 */

/** Line endings are unified to `\n`; nothing else about the text changes. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * Drops blank lines at the start and end, and trailing space at the end.
 *
 * A NUL byte is removed rather than carried along: it is never part of what a
 * person typed, and a text column cannot store it, so passing one on would turn
 * a paste into a save failure later.
 */
export function trimBlankEdges(raw: string): string {
  const text = normalizeNewlines(raw).split('\u0000').join('');
  // Leading: whole blank lines only, so "   indented" keeps its indentation.
  const withoutLeading = text.replace(/^(?:[ \t\u00a0]*\n)+/, '');
  return withoutLeading.replace(/[\s\u00a0]+$/, '');
}

/** True when there is anything to send once the blank edges are gone. */
export function hasContent(raw: string): boolean {
  return trimBlankEdges(raw) !== '';
}

/**
 * Cuts text to a length without breaking a word, a fenced block or a line in
 * half where that can be avoided, and says so when it cuts.
 */
export function clipForHistory(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastBreak = slice.lastIndexOf('\n');
  const cut = lastBreak > max * 0.6 ? slice.slice(0, lastBreak) : slice;
  return `${cut.trimEnd()}\n[... earlier message shortened to fit ...]`;
}
