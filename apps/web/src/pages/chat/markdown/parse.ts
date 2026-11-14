/**
 * A small, dependency-free Markdown parser for chat answers.
 *
 * It produces a typed tree and never HTML. The renderer turns that tree into React
 * elements, so there is no path by which markup in a message can run: a `<script>`
 * in an answer is just text in a paragraph.
 *
 * Supported blocks: headings, paragraphs, bullet / numbered / nested lists, task
 * items, blockquotes, fenced and indented code, tables, horizontal rules.
 * Supported inline: bold, italic, strike, inline code, links, bare URLs, hard breaks.
 *
 * Incomplete input is a first-class case, because answers are rendered while they
 * are still arriving: an unclosed fence is an open code block, an unclosed `**`
 * stays literal text, and a table with only a header row is a paragraph until its
 * delimiter row arrives. Nothing here throws.
 */

export type Inline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'break' }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong'; readonly children: readonly Inline[] }
  | { readonly kind: 'em'; readonly children: readonly Inline[] }
  | { readonly kind: 'del'; readonly children: readonly Inline[] }
  | { readonly kind: 'link'; readonly href: string; readonly children: readonly Inline[] };

export type TableAlign = 'left' | 'center' | 'right' | null;

export interface ListItem {
  readonly children: readonly Block[];
  /** `null` for an ordinary item, true/false for a `[x]` / `[ ]` task item. */
  readonly checked: boolean | null;
}

export type Block =
  | { readonly kind: 'paragraph'; readonly children: readonly Inline[] }
  | {
      readonly kind: 'heading';
      readonly level: 1 | 2 | 3 | 4 | 5 | 6;
      readonly children: readonly Inline[];
    }
  | {
      readonly kind: 'code';
      readonly language: string;
      readonly text: string;
      readonly open: boolean;
    }
  | { readonly kind: 'quote'; readonly children: readonly Block[] }
  | { readonly kind: 'rule' }
  | {
      readonly kind: 'list';
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly ListItem[];
    }
  | {
      readonly kind: 'table';
      readonly align: readonly TableAlign[];
      readonly head: readonly (readonly Inline[])[];
      readonly rows: readonly (readonly (readonly Inline[])[])[];
    };

const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BULLET = /^( *)([-*+])[ \t]+(.*)$/;
const ORDERED = /^( *)(\d{1,9})[.)][ \t]+(.*)$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const TASK = /^\[([ xX])\][ \t]+(.*)$/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-{1,}:?[ \t]*(?:\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/;

/** Link targets that may be followed. Anything else is shown as plain text. */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (href === '') return null;
  if (/^(https?:\/\/|mailto:)/i.test(href)) return href;
  // Same-page and relative targets are harmless; a scheme of any other kind
  // (javascript:, data:, vbscript:, file:) is not.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  if (href.startsWith('//')) return null;
  return href;
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i] as string;
    if (char === '\\' && body[i + 1] === '|') {
      current += '|';
      i += 1;
    } else if (char === '`') {
      // A pipe inside a code span belongs to the code, not to the table.
      let run = 1;
      while (body[i + run] === '`') run += 1;
      const close = body.indexOf('`'.repeat(run), i + run);
      if (close === -1) {
        current += '`'.repeat(run);
        i += run - 1;
      } else {
        current += body.slice(i, close + run);
        i = close + run - 1;
      }
    } else if (char === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function alignOf(cell: string): TableAlign {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

/** Inline parsing: emphasis, code, links, bare URLs and hard breaks. */
export function parseInline(source: string): readonly Inline[] {
  const out: Inline[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer !== '') {
      out.push({ kind: 'text', text: buffer });
      buffer = '';
    }
  };

  let i = 0;
  while (i < source.length) {
    const char = source[i] as string;

    if (char === '\\' && i + 1 < source.length) {
      const next = source[i + 1] as string;
      if (/[\\`*_{}[\]()#+\-.!|~>]/.test(next)) {
        buffer += next;
        i += 2;
        continue;
      }
    }

    if (char === '\n') {
      // Two trailing spaces or a backslash is the Markdown hard break. A bare
      // newline inside a paragraph is also kept as a break: chat text is written
      // line by line, and joining lines would reproduce the bug this exists to fix.
      buffer = buffer.replace(/ +$/, '');
      flush();
      out.push({ kind: 'break' });
      i += 1;
      continue;
    }

    if (char === '`') {
      let run = 1;
      while (source[i + run] === '`') run += 1;
      const ticks = '`'.repeat(run);
      const close = source.indexOf(ticks, i + run);
      if (close > i + run) {
        flush();
        const inner = source.slice(i + run, close).replace(/\n/g, ' ');
        out.push({
          kind: 'code',
          text: inner.length > 2 ? inner.replace(/^ (.*) $/, '$1') : inner,
        });
        i = close + run;
        continue;
      }
      buffer += ticks;
      i += run;
      continue;
    }

    if (char === '[') {
      const closeLabel = findClosingBracket(source, i);
      if (closeLabel !== -1 && source[closeLabel + 1] === '(') {
        const closeParen = findClosingParen(source, closeLabel + 1);
        if (closeParen !== -1) {
          const label = source.slice(i + 1, closeLabel);
          const target =
            source
              .slice(closeLabel + 2, closeParen)
              .trim()
              .split(/\s+/)[0] ?? '';
          const href = safeHref(target.replace(/^<|>$/g, ''));
          flush();
          if (href !== null && label !== '') {
            out.push({ kind: 'link', href, children: parseInline(label) });
          } else {
            // An unsafe or empty target: show what the person would have read.
            out.push(...parseInline(label === '' ? target : label));
          }
          i = closeParen + 1;
          continue;
        }
      }
    }

    if (char === '*' || char === '_' || char === '~') {
      const double = source[i + 1] === char;
      const marker = double ? char + char : char;
      const canOpen = isOpener(source, i, marker.length);
      if (canOpen && (char !== '~' || double)) {
        const close = findCloser(source, i + marker.length, marker);
        if (close !== -1) {
          flush();
          const inner = parseInline(source.slice(i + marker.length, close));
          if (char === '~') out.push({ kind: 'del', children: inner });
          else if (double) out.push({ kind: 'strong', children: inner });
          else out.push({ kind: 'em', children: inner });
          i = close + marker.length;
          continue;
        }
      }
      buffer += marker;
      i += marker.length;
      continue;
    }

    if (char === 'h' || char === 'H') {
      const match = /^https?:\/\/[^\s<>"'`]+/i.exec(source.slice(i));
      const previous = i === 0 ? ' ' : (source[i - 1] as string);
      if (match !== null && /[\s([{>,;:]/.test(previous)) {
        let url = match[0];
        // Trailing punctuation belongs to the sentence, not the address.
        while (/[.,;:!?'")\]}]$/.test(url)) {
          if (
            url.endsWith(')') &&
            (url.match(/\(/g) ?? []).length >= (url.match(/\)/g) ?? []).length
          )
            break;
          url = url.slice(0, -1);
        }
        flush();
        out.push({ kind: 'link', href: url, children: [{ kind: 'text', text: url }] });
        i += url.length;
        continue;
      }
    }

    buffer += char;
    i += 1;
  }
  flush();
  return out;
}

function findClosingBracket(source: string, from: number): number {
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    const char = source[i];
    if (char === '\\') {
      i += 1;
    } else if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) return i;
    } else if (char === '\n' && source[i + 1] === '\n') {
      return -1;
    }
  }
  return -1;
}

function findClosingParen(source: string, from: number): number {
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    const char = source[i];
    if (char === '\\') {
      i += 1;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) return i;
    } else if (char === '\n') {
      return -1;
    }
  }
  return -1;
}

/** An opener must be followed by something that is not whitespace. */
function isOpener(source: string, index: number, length: number): boolean {
  const after = source[index + length];
  if (after === undefined || /\s/.test(after)) return false;
  const marker = source[index] as string;
  if (marker === '_') {
    // snake_case_names are not emphasis.
    const before = index === 0 ? ' ' : (source[index - 1] as string);
    if (/[A-Za-z0-9]/.test(before)) return false;
  }
  return true;
}

function findCloser(source: string, from: number, marker: string): number {
  const char = marker[0] as string;
  for (let i = from; i < source.length; i += 1) {
    const current = source[i] as string;
    if (current === '\\') {
      i += 1;
      continue;
    }
    if (current === '`') {
      // Skip a code span: markers inside it are not emphasis.
      let run = 1;
      while (source[i + run] === '`') run += 1;
      const close = source.indexOf('`'.repeat(run), i + run);
      if (close !== -1) i = close + run - 1;
      continue;
    }
    if (current !== char) continue;
    if (marker.length === 2 && source[i + 1] !== char) continue;
    if (marker.length === 1 && source[i + 1] === char) {
      i += 1;
      continue;
    }
    const before = source[i - 1];
    if (before === undefined || /\s/.test(before)) continue;
    if (char === '_') {
      const after = source[i + marker.length];
      if (after !== undefined && /[A-Za-z0-9]/.test(after)) continue;
    }
    if (i === from) continue;
    return i;
  }
  return -1;
}

function indentOf(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width += 1;
    else if (char === '\t') width += 4;
    else break;
  }
  return width;
}

function stripIndent(line: string, width: number): string {
  let removed = 0;
  let index = 0;
  while (index < line.length && removed < width) {
    const char = line[index];
    if (char === ' ') removed += 1;
    else if (char === '\t') removed += 4;
    else break;
    index += 1;
  }
  return line.slice(index);
}

/** Parses a whole message into blocks. */
export function parseMarkdown(input: string): readonly Block[] {
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  return parseBlocks(lines);
}

function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line) ||
    RULE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line)
  );
}

function parseBlocks(lines: readonly string[]): readonly Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] as string;

    if (isBlank(line)) {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[2] as string;
      const language = fence[3] ?? '';
      const baseIndent = (fence[1] ?? '').length;
      const body: string[] = [];
      let closed = false;
      i += 1;
      while (i < lines.length) {
        const current = lines[i] as string;
        const closing = new RegExp(
          `^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`,
        );
        if (closing.test(current)) {
          closed = true;
          i += 1;
          break;
        }
        body.push(stripIndent(current, baseIndent));
        i += 1;
      }
      blocks.push({ kind: 'code', language, text: body.join('\n'), open: !closed });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({
        kind: 'heading',
        level: (heading[1] as string).length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline((heading[2] as string).trim()),
      });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const current = lines[i] as string;
        const match = QUOTE.exec(current);
        if (match !== null) {
          inner.push(match[1] as string);
          i += 1;
        } else if (!isBlank(current) && inner.length > 0 && !startsBlock(current)) {
          // Lazy continuation of the quoted paragraph.
          inner.push(current);
          i += 1;
        } else {
          break;
        }
      }
      blocks.push({ kind: 'quote', children: parseBlocks(inner) });
      continue;
    }

    // A table needs a header row and a delimiter row under it. Until the
    // delimiter arrives the header is an ordinary paragraph.
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      TABLE_DELIMITER.test(lines[i + 1] as string)
    ) {
      const head = splitRow(line);
      const delimiter = splitRow(lines[i + 1] as string);
      if (head.length === delimiter.length && delimiter.every((cell) => /^:?-+:?$/.test(cell))) {
        const rows: string[][] = [];
        i += 2;
        while (
          i < lines.length &&
          !isBlank(lines[i] as string) &&
          (lines[i] as string).includes('|')
        ) {
          rows.push(splitRow(lines[i] as string));
          i += 1;
        }
        blocks.push({
          kind: 'table',
          align: delimiter.map(alignOf),
          head: head.map((cell) => parseInline(cell)),
          rows: rows.map((row) => head.map((_, column) => parseInline(row[column] ?? ''))),
        });
        continue;
      }
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const parsed = parseList(lines, i);
      blocks.push(parsed.block);
      i = parsed.next;
      continue;
    }

    // Paragraph: runs until a blank line or the start of another block. Single
    // newlines inside it are preserved as line breaks by parseInline.
    const para: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const current = lines[i] as string;
      if (isBlank(current) || startsBlock(current)) break;
      if (
        current.includes('|') &&
        i + 1 < lines.length &&
        TABLE_DELIMITER.test(lines[i + 1] as string)
      ) {
        break;
      }
      para.push(current);
      i += 1;
    }
    blocks.push({
      kind: 'paragraph',
      children: parseInline(para.map((l) => l.replace(/^ +/, '')).join('\n')),
    });
  }
  return blocks;
}

function parseList(lines: readonly string[], from: number): { block: Block; next: number } {
  const first = lines[from] as string;
  const firstBullet = BULLET.exec(first);
  const firstOrdered = ORDERED.exec(first);
  const ordered = firstBullet === null;
  const baseIndent = ((firstBullet ?? firstOrdered) as RegExpExecArray)[1]?.length ?? 0;
  const bulletChar = firstBullet?.[2];
  const start = ordered ? Number((firstOrdered as RegExpExecArray)[2]) : 1;

  const items: ListItem[] = [];
  let i = from;

  while (i < lines.length) {
    const line = lines[i] as string;
    const bullet = BULLET.exec(line);
    const number = ORDERED.exec(line);
    const marker = ordered ? number : bullet;
    if (marker === null) break;
    const indent = (marker[1] as string).length;
    if (indent !== baseIndent && Math.abs(indent - baseIndent) < 2) {
      // Off by one space is the same list written untidily.
    } else if (indent < baseIndent || indent >= baseIndent + 2) {
      break;
    }
    if (!ordered && bullet !== null && bullet[2] !== bulletChar && indent === baseIndent) {
      // A different bullet character starts a new list, as in CommonMark.
      break;
    }

    const contentOffset = line.length - (marker[3] as string).length;
    let text = marker[3] as string;
    const body: string[] = [];
    let checked: boolean | null = null;
    const task = TASK.exec(text);
    if (task !== null) {
      checked = (task[1] as string).toLowerCase() === 'x';
      text = task[2] as string;
    }
    body.push(text);
    i += 1;

    // Continuation: more-indented lines, plus blank lines between them.
    while (i < lines.length) {
      const current = lines[i] as string;
      if (isBlank(current)) {
        // A blank line only continues the item when the next line is indented under it.
        let peek = i + 1;
        while (peek < lines.length && isBlank(lines[peek] as string)) peek += 1;
        if (peek < lines.length && indentOf(lines[peek] as string) >= baseIndent + 2) {
          body.push('');
          i += 1;
          continue;
        }
        break;
      }
      const currentIndent = indentOf(current);
      if (currentIndent >= baseIndent + 2) {
        body.push(
          stripIndent(current, Math.min(currentIndent, Math.max(contentOffset, baseIndent + 2))),
        );
        i += 1;
        continue;
      }
      // A less-indented line that is not a new marker is a lazy continuation.
      if (!startsBlock(current) && body.length > 0 && !(body[body.length - 1] === '')) {
        body.push(current.trim());
        i += 1;
        continue;
      }
      break;
    }

    items.push({ children: parseBlocks(body), checked });
    // Blank lines between sibling items do not end the list.
    let peek = i;
    while (peek < lines.length && isBlank(lines[peek] as string)) peek += 1;
    if (peek > i && peek < lines.length) {
      const next = ordered
        ? ORDERED.exec(lines[peek] as string)
        : BULLET.exec(lines[peek] as string);
      if (next !== null && (next[1] as string).length === baseIndent) {
        i = peek;
      }
    }
  }

  return { block: { kind: 'list', ordered, start, items }, next: i };
}
