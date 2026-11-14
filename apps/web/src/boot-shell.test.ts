import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The first-paint frame in index.html, pinned against the files it imitates.
 *
 * It exists because the page used to be blank until the bundle and the runtime
 * configuration had both arrived. A frame that quietly drifts from the real shell
 * (other colours, another storage key, a bar of different height) would flash and
 * jump when React replaces it, so the numbers it repeats are checked here.
 */

const read = (relative: string) => readFileSync(resolve(__dirname, relative), 'utf8');
const html = read('../index.html');
const tokens = read('./design/tokens.css');

function block(source: string, selector: string): string {
  const start = source.indexOf(selector);
  expect(start, `${selector} not found`).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf('}', start));
}

describe('the first-paint frame', () => {
  it('sits inside #root, so the first React commit replaces it', () => {
    const root = html.indexOf('<div id="root">');
    const frame = html.indexOf('data-boot', root);
    const script = html.indexOf('type="module"');
    expect(root).toBeGreaterThan(-1);
    expect(frame).toBeGreaterThan(root);
    expect(frame).toBeLessThan(script);
  });

  it('is hidden from assistive technology and holds no live content', () => {
    const frame = html.slice(html.indexOf('<div class="vb"'), html.indexOf('type="module"'));
    expect(frame).toContain('aria-hidden="true"');
    // Nothing here may be read as an answer, an account, a balance or a name.
    const text = frame
      .replace(/<[^>]+>/g, ' ')
      // The slice ends inside the module tag, so drop any unfinished one.
      .replace(/<[^>]*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    expect(text).toBe('');
  });

  it('reads the same theme preference the ThemeProvider writes', () => {
    const provider = read('./theme/ThemeProvider.tsx');
    const key = provider.match(/STORAGE_KEY = '([^']+)'/)?.[1];
    expect(key).toBe('veltravia.theme-preference');
    expect(html).toContain(`getItem('${key}')`);
    expect(html).toContain("setAttribute('data-theme'");
  });

  it('repeats the real light and dark surface colours', () => {
    const light = block(tokens, ':root {');
    const dark = block(tokens, "[data-theme='dark'] {");
    const frame = html.slice(html.indexOf('<style data-boot>'), html.indexOf('</style>'));

    // Light: the chat pane the frame stands in for, the raised card surface,
    // the drawer's own milk, hairline.
    expect(light).toContain('--v-chat-canvas: #faf9fc');
    expect(light).toContain('--v-drawer-surface: #f8f6f4');
    expect(frame).toContain('--vb-drawer: #f8f6f4');
    expect(frame).toContain('--vb-bg: #faf9fc');
    expect(frame).toContain('--vb-surface: #ffffff');
    expect(frame).toContain('--vb-line: #e7e2dd');
    expect(frame).toContain('--vb-bone-a: #f3f1ef');
    expect(frame).toContain('--vb-bone-b: #e9e5df');

    // Dark: the same roles as tokens.css names them.
    expect(dark).toContain('--v-surface: #171512');
    expect(dark).toContain('--v-border: #2a2828');
    expect(frame).toContain('--vb-surface: #171512');
    expect(frame).toContain('--vb-drawer: #171512');
    expect(frame).toContain('--vb-line: #2a2828');
    expect(dark).toContain('--v-chat-canvas: #141312');
    expect(frame).toContain('--vb-bg: #141312');
  });

  it('matches the shell geometry it stands in for', () => {
    const shell = read('./shell/shell.css');
    const drawer = read('./shell/mobile-drawer.css');
    const frame = html.slice(html.indexOf('<style data-boot>'), html.indexOf('</style>'));

    // Top bar: 56px tall (3.5rem), 12px left and 14px right padding.
    expect(block(shell, '.v-topbar {')).toContain('height: 3.5rem');
    expect(frame).toMatch(/\.vb__bar\s*{[^}]*block-size:\s*56px/);
    expect(frame).toMatch(/\.vb__bar\s*{[^}]*padding:\s*0 14px 0 12px/);

    // Docked navigation column: 83% up to 300px, from 901px, head rule 47px down.
    expect(drawer).toContain('@media (min-width: 901px)');
    expect(drawer).toMatch(/\.v-drawer--docked\s*{[^}]*max-inline-size:\s*300px/);
    expect(frame).toContain('@media (min-width: 901px)');
    expect(frame).toMatch(/\.vb__nav\s*{[^}]*inline-size:\s*83%/);
    expect(frame).toMatch(/\.vb__nav\s*{[^}]*max-inline-size:\s*300px/);
    expect(frame).toMatch(/\.vb__nav-head\s*{[^}]*min-block-size:\s*47px/);

    // Navigation row pitch 41dp (a 37dp pill plus 2dp either side), the
    // reference's rhythm; message box 100dp tall, 16px radius, 720px wide.
    expect(block(drawer, '.v-drawer__row {')).toContain('min-height: 37px');
    expect(block(drawer, '.v-drawer__list > li {')).toContain('padding-block: 2px');
    expect(frame).toMatch(/\.vb__row\s*{[^}]*min-block-size:\s*41px/);
    const chat = read('./pages/chat/chat.css');
    expect(block(chat, '.v-chat-composer {')).toContain('max-width: 720px');
    expect(block(chat, '.v-chat-composer {')).toContain('border-radius: 16px');
    expect(frame).toMatch(/\.vb__box\s*{[^}]*max-inline-size:\s*720px/);
    expect(frame).toMatch(/\.vb__box\s*{[^}]*block-size:\s*100px/);
    expect(frame).toMatch(/\.vb__box\s*{[^}]*border-radius:\s*16px/);
  });

  it('stops moving for visitors who ask for less motion', () => {
    const frame = html.slice(html.indexOf('<style data-boot>'), html.indexOf('</style>'));
    expect(frame).toMatch(
      /prefers-reduced-motion: reduce\)\s*{[^}]*\.vb__bone\s*{[^}]*animation:\s*none/,
    );
  });
});

describe('the hand-off', () => {
  it('removes the frame stylesheet only after React has committed', () => {
    const main = read('./main.tsx');
    const render = main.indexOf('.render(');
    const remove = main.indexOf("style[data-boot]')?.remove()");
    expect(render).toBeGreaterThan(-1);
    expect(remove).toBeGreaterThan(render);
    // Two animation frames: the commit paints first, then the dead rules go.
    expect(main.match(/requestAnimationFrame/g)?.length).toBe(2);
  });
});
