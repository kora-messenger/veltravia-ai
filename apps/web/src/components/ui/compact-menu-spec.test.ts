import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * jsdom has no layout, so these read the stylesheet itself. The numbers were
 * measured from Base44's own composer popup on a 390px phone (263px wide, a
 * 30px row pitch, level with its button and 7px clear of it); a browser check
 * at 320 to 430px confirmed the rendered box matches.
 */
const css = readFileSync(resolve(__dirname, 'ui.css'), 'utf8');

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} is missing`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
}

describe('the compact popup stylesheet', () => {
  it('is 263px wide, 7px above its button and level with it', () => {
    const panel = rule('.v-menu__panel--compact');
    expect(panel).toContain('width: 263px');
    expect(panel).toContain('left: 0');
    expect(panel).toContain('bottom: calc(100% + 7px)');
  });

  it('uses a 30px row with 8px around the list', () => {
    expect(rule('.v-menu__panel--compact')).toContain('padding: 8px');
    expect(rule('.v-menu__panel--compact .v-menu__item')).toContain('min-height: 30px');
  });

  it('keeps each row on one line so the Drive hint cannot wrap it taller', () => {
    expect(rule('.v-menu__panel--compact .v-menu__item-label')).toContain('white-space: nowrap');
    expect(rule('.v-menu__panel--compact .v-menu__hint')).toContain('white-space: nowrap');
  });

  it('anchors to its own button even inside the composer row', () => {
    expect(css).toContain('.v-chat-composer__row .v-menu.v-menu--compact');
  });

  it('does not animate beyond the shared pop-in', () => {
    expect(rule('.v-menu__panel--compact')).not.toContain('@keyframes');
  });
});
