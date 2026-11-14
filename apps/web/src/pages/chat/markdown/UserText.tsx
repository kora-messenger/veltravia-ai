import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { safeHref } from './parse';

/**
 * A person's own message, shown the way they wrote it.
 *
 * It is deliberately NOT run through the Markdown renderer. Someone pasting a
 * prompt with `- ` bullets, `IMPORTANT:` headings and blank lines expects to see
 * those lines back, character for character. Re-interpreting them (turning `-`
 * into a bullet glyph, `#` into a heading, `*` into italics) would change their
 * words. So the text keeps its newlines, its blank lines and its indentation
 * (`white-space: pre-wrap` in the stylesheet), and only two things get structure:
 *
 * - a fenced code block, which is shown monospaced and scrolls sideways;
 * - an http(s) address, which becomes a link.
 *
 * Everything is React text, never markup.
 */

interface Segment {
  readonly kind: 'text' | 'code';
  readonly text: string;
  readonly language: string;
}

const FENCE_LINE = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;

/** Splits on fenced blocks, keeping every other character exactly. */
export function splitFences(text: string): readonly Segment[] {
  const lines = text.split('\n');
  const segments: Segment[] = [];
  let prose: string[] = [];
  let i = 0;
  const flushProse = () => {
    if (prose.length > 0) {
      segments.push({ kind: 'text', text: prose.join('\n'), language: '' });
      prose = [];
    }
  };
  while (i < lines.length) {
    const open = FENCE_LINE.exec(lines[i] as string);
    if (open === null) {
      prose.push(lines[i] as string);
      i += 1;
      continue;
    }
    const marker = open[2] as string;
    const closing = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
    let end = i + 1;
    while (end < lines.length && !closing.test(lines[end] as string)) end += 1;
    flushProse();
    segments.push({
      kind: 'code',
      text: lines.slice(i + 1, end).join('\n'),
      language: open[3] ?? '',
    });
    // An unclosed fence runs to the end of the message, as it was typed.
    i = end + 1;
  }
  flushProse();
  return segments;
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;

function linkify(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    let url = match[0];
    while (/[.,;:!?'")\]}]$/.test(url)) {
      if (url.endsWith(')') && (url.match(/\(/g) ?? []).length >= (url.match(/\)/g) ?? []).length)
        break;
      url = url.slice(0, -1);
    }
    const href = safeHref(url);
    if (href === null) continue;
    if (start > last)
      nodes.push(<Fragment key={`${keyPrefix}t${index}`}>{text.slice(last, start)}</Fragment>);
    nodes.push(
      <a
        key={`${keyPrefix}a${index}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
      >
        {url}
      </a>,
    );
    last = start + url.length;
    index += 1;
  }
  if (last < text.length)
    nodes.push(<Fragment key={`${keyPrefix}t${index}`}>{text.slice(last)}</Fragment>);
  return nodes;
}

export function UserText({ text }: { readonly text: string }) {
  const segments = splitFences(text);
  // No fenced block: the common case is one text node, which keeps the bubble's
  // content a plain string for anything (copy, selection, tests) that reads it.
  if (segments.length === 1 && segments[0]?.kind === 'text' && !/https?:\/\//i.test(text)) {
    return <>{text}</>;
  }
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === 'code' ? (
          <span key={index} className="v-md__code v-md__code--user">
            {segment.language !== '' ? (
              <span className="v-md__code-label" aria-hidden="true">
                {segment.language}
              </span>
            ) : null}
            <pre tabIndex={0}>
              <code>{segment.text}</code>
            </pre>
          </span>
        ) : (
          <Fragment key={index}>{linkify(segment.text, `s${index}`)}</Fragment>
        ),
      )}
    </>
  );
}
