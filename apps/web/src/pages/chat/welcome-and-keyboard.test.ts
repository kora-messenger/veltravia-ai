import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Two behaviours the screen depends on but a component test cannot see, because
 * jsdom has no keyboard and applies no stylesheet. They are pinned against the
 * shipped files instead, so a refactor cannot quietly undo them.
 */

const read = (relative: string) => readFileSync(resolve(__dirname, relative), 'utf8');

describe('the keyboard', () => {
  it('resizes the page content, so the tips and the box rise together', () => {
    const html = read('../../../index.html');
    // Prettier splits the tag across lines, so match the whole element.
    const tag = html.match(/<meta[^>]*name="viewport"[^>]*>/)?.[0] ?? '';
    const viewport = tag.match(/content="([^"]*)"/)?.[1] ?? '';
    // Without this Chrome only resizes the visual viewport: the box floats over
    // the keyboard and the tips are covered instead of riding up with it.
    expect(viewport).toContain('interactive-widget=resizes-content');
  });

  it('keeps the tips in the same footer block as the type box', () => {
    const css = read('./chat.css');
    expect(css).toMatch(/\.v-chat__tips\s*{/);
    // The footer is the one block that does not scroll; the tips must not be
    // positioned out of it.
    const tips = css.slice(
      css.indexOf('.v-chat__tips {'),
      css.indexOf('}', css.indexOf('.v-chat__tips {')),
    );
    expect(tips).not.toMatch(/position:\s*(fixed|absolute)/);
  });
});

describe('the welcome', () => {
  it('is a headline sized to the reference, not the 22px quiet line', () => {
    const css = read('./chat.css');
    const block = css.slice(
      css.indexOf('.v-chat__greeting {'),
      css.indexOf('.v-chat__greeting-line'),
    );
    const size = block.match(/font-size:\s*clamp\(([^)]*)\)/)?.[1] ?? '';
    // Measured: the widest reference line is 338dp of 411dp, which is about 32px
    // type in this face. The cap keeps a desktop window from ballooning.
    expect(size).toContain('7.85vw');
    expect(block).not.toContain('1.375rem');
  });
});
