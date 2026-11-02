/**
 * Two small formatting helpers the timeline shares.
 *
 * What a run is *doing* used to be derived here, from whatever each route
 * returned. That mapping now lives on the server, which owns the run and can
 * validate what it sends; this file keeps only the presentation arithmetic.
 */

/** Longer labels are trimmed, not wrapped onto three lines. */
const MAX_LABEL_CHARS = 80;

/** Collapses whitespace and trims a label at a word boundary. */
export function shorten(text: string, max = MAX_LABEL_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Formats a duration the way a person reads it. */
export function formatDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  // Round in integers first: 1450/1000 = 1.45, which float formatting reports
  // as "1.4" because 1.45 has no exact binary form.
  if (ms < 10000) return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
  return `${Math.round(ms / 1000)} s`;
}
