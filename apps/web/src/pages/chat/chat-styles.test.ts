import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Two cascading rules in the chat stylesheet are load-bearing, and both fail
 * silently when they regress: a bubble without `pre-wrap` collapses a pasted
 * brief into one paragraph, and a margin reset with an element in it
 * out-specifies the rhythm rule and flattens every gap to zero. jsdom does no
 * layout, so the stylesheet is read as text and its shape asserted.
 */

const css = readFileSync('apps/web/src/pages/chat/chat.css', 'utf8');

function rule(selector: string): string {
  const index = css.indexOf(`${selector} {`);
  expect(index, `${selector} is missing`).toBeGreaterThanOrEqual(0);
  return css.slice(index, css.indexOf('}', index));
}

describe('the sent-message bubble', () => {
  it("keeps the person's own line breaks", () => {
    expect(rule('.v-chat__bubble')).toContain('white-space: pre-wrap');
  });

  it('never widens the column with an unbroken string', () => {
    const bubble = rule('.v-chat__bubble');
    expect(bubble).toMatch(/word-break: break-word|overflow-wrap: anywhere/);
    expect(bubble).toContain('min-width: 0');
  });
});

describe('the answer column', () => {
  it('may shrink as a flex item, so a wide table scrolls instead of overflowing', () => {
    expect(rule('.v-chat__answer')).toContain('min-width: 0');
  });

  it('wraps rather than moving the page sideways', () => {
    const markdown = rule('.v-md');
    expect(markdown).toContain('max-width: 100%');
    expect(markdown).toContain('overflow-wrap: anywhere');
  });
});

describe('vertical rhythm', () => {
  it('resets block margins without specificity, so the gap rules can win', () => {
    expect(css).toMatch(/\.v-md :where\(/);
    // A bare element reset is exactly the bug this guards against.
    expect(css).not.toMatch(/\.v-md (?:p|li|ul|ol|blockquote|h[1-6])(?:,\n[^}]*)? \{\s*margin: 0;/);
  });

  it('gives every block a gap below the one above it', () => {
    expect(rule('.v-md > * + *')).toContain('margin-top');
  });

  it('gives a heading more air above it than a paragraph', () => {
    const sectionGap = /\.v-md > \* \+ :where\(h1[^)]*\) \{\s*margin-top: ([\d.]+)em/.exec(
      css,
    )?.[1];
    const blockGap = /\.v-md > \* \+ \* \{\s*margin-top: ([\d.]+)em/.exec(css)?.[1];
    expect(Number(sectionGap)).toBeGreaterThan(Number(blockGap));
  });

  it('keeps a heading close to the text it introduces', () => {
    expect(css).toMatch(/\.v-md :where\(h1[^)]*\) \+ \* \{\s*margin-top: [\d.]+em/);
  });
});

describe('content that can be wider than the column', () => {
  it('scrolls a code block and a table inside their own frames', () => {
    expect(rule('.v-md__code pre')).toContain('overflow-x: auto');
    expect(rule('.v-md__table')).toContain('overflow-x: auto');
  });

  it('keeps code unwrapped so its indentation stays meaningful', () => {
    expect(rule('.v-md__code pre')).toContain('white-space: pre');
  });

  it('keeps a table header on one line', () => {
    expect(rule('.v-md__table th')).toContain('white-space: nowrap');
  });
});
