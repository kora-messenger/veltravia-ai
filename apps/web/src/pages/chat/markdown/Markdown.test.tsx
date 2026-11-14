// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Markdown } from './Markdown';
import { UserText, splitFences } from './UserText';
import { parseMarkdown, safeHref } from './parse';

afterEach(cleanup);

function html(text: string): HTMLElement {
  const { container } = render(<Markdown text={text} />);
  return container.firstElementChild as HTMLElement;
}

describe('paragraphs and line breaks', () => {
  it('keeps separate paragraphs separate', () => {
    const root = html('First idea.\n\nSecond idea.\n\nThird idea.');
    const paragraphs = root.querySelectorAll('p');
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[1]?.textContent).toBe('Second idea.');
  });

  it('keeps a single newline inside a paragraph as a line break, never joining the lines', () => {
    const root = html('line one\nline two');
    expect(root.querySelectorAll('p')).toHaveLength(1);
    expect(root.querySelectorAll('br')).toHaveLength(1);
    expect(root.textContent).toBe('line oneline two');
  });

  it('handles Windows line endings the same as Unix ones', () => {
    expect(html('a\r\n\r\nb').querySelectorAll('p')).toHaveLength(2);
  });
});

describe('headings', () => {
  it('renders each level as its own heading element', () => {
    const root = html('# One\n\n## Two\n\n### Three\n\nbody');
    expect(root.querySelector('h1')?.textContent).toBe('One');
    expect(root.querySelector('h2')?.textContent).toBe('Two');
    expect(root.querySelector('h3')?.textContent).toBe('Three');
  });

  it('does not show the # symbols', () => {
    expect(html('## Plan').textContent).toBe('Plan');
  });

  it('does not treat a hash with no space as a heading', () => {
    expect(html('#hashtag').querySelector('h1')).toBeNull();
  });
});

describe('lists', () => {
  it('renders bullets as a list with no raw dashes', () => {
    const root = html('- alpha\n- beta\n- gamma');
    const items = root.querySelectorAll('ul > li');
    expect(items).toHaveLength(3);
    expect(root.textContent).toBe('alphabetagamma');
  });

  it('renders numbered steps in order and honours the start number', () => {
    const root = html('3. third\n4. fourth');
    const list = root.querySelector('ol');
    expect(list?.getAttribute('start')).toBe('3');
    expect(list?.querySelectorAll('li')).toHaveLength(2);
  });

  it('nests a list under the item that owns it', () => {
    const root = html('- parent\n  - child one\n  - child two\n- sibling');
    const top = root.querySelector('ul') as HTMLElement;
    expect(top.children).toHaveLength(2);
    expect(top.querySelectorAll('ul > li > ul > li')).toHaveLength(2);
  });

  it('nests a numbered list inside a bullet', () => {
    const root = html('- step group\n  1. one\n  2. two');
    expect(root.querySelectorAll('ul > li > ol > li')).toHaveLength(2);
  });

  it('keeps a list that follows a heading and a paragraph', () => {
    const root = html(
      'IMPORTANT:\n\n- Preserve existing functionality.\n- Keep the application name.',
    );
    expect(root.querySelectorAll('p')).toHaveLength(1);
    expect(root.querySelectorAll('li')).toHaveLength(2);
  });

  it('renders task items with a real, disabled checkbox', () => {
    const root = html('- [x] done\n- [ ] todo');
    const boxes = root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]?.checked).toBe(true);
    expect(boxes[1]?.checked).toBe(false);
    expect(boxes[0]?.disabled).toBe(true);
  });
});

describe('inline formatting', () => {
  it('renders bold, italic and strike without their markers', () => {
    const root = html('**bold** and *italic* and ~~gone~~');
    expect(root.querySelector('strong')?.textContent).toBe('bold');
    expect(root.querySelector('em')?.textContent).toBe('italic');
    expect(root.querySelector('del')?.textContent).toBe('gone');
    expect(root.textContent).toBe('bold and italic and gone');
  });

  it('renders inline code and does not format inside it', () => {
    const root = html('run `npm **test**` now');
    expect(root.querySelector('code')?.textContent).toBe('npm **test**');
    expect(root.querySelector('strong')).toBeNull();
  });

  it('leaves snake_case and a lone asterisk alone', () => {
    const root = html('use my_var_name and 2 * 3 = 6');
    expect(root.querySelector('em')).toBeNull();
    expect(root.textContent).toBe('use my_var_name and 2 * 3 = 6');
  });

  it('honours a backslash escape', () => {
    expect(html('\\*not italic\\*').textContent).toBe('*not italic*');
  });
});

describe('blockquotes and rules', () => {
  it('renders a quote with its own paragraphs', () => {
    const root = html('> quoted line\n>\n> second paragraph');
    expect(root.querySelectorAll('blockquote p')).toHaveLength(2);
  });

  it('renders a horizontal rule', () => {
    expect(html('above\n\n---\n\nbelow').querySelectorAll('hr')).toHaveLength(1);
  });
});

describe('code blocks', () => {
  const sample = 'Intro\n\n```ts\nconst a = 1;\n\n  const b = 2;\n```\n\nOutro';

  it('keeps every line, the blank line and the indentation inside a fence', () => {
    const root = html(sample);
    const code = root.querySelector('pre code') as HTMLElement;
    expect(code.textContent).toBe('const a = 1;\n\n  const b = 2;');
  });

  it('names the language', () => {
    expect(html(sample).querySelector('.v-md__code-label')?.textContent).toBe('ts');
  });

  it('does not interpret Markdown inside a fence', () => {
    const root = html('```\n# not a heading\n- not a list\n**not bold**\n```');
    expect(root.querySelector('h1')).toBeNull();
    expect(root.querySelector('li')).toBeNull();
    expect(root.querySelector('pre')?.textContent).toContain('**not bold**');
  });

  it('shows an unclosed fence as an open block while the answer is still arriving', () => {
    const root = html('Here you go:\n\n```js\nconst x = 1;');
    expect(root.querySelector('.v-md__code')?.getAttribute('data-open')).toBe('true');
    expect(root.querySelector('pre code')?.textContent).toBe('const x = 1;');
  });

  it('makes the block keyboard-scrollable', () => {
    expect(html(sample).querySelector('pre')?.getAttribute('tabindex')).toBe('0');
  });
});

describe('tables', () => {
  const table =
    '| Name | Qty | Price |\n| :--- | :-: | ---: |\n| Apple | 3 | 1.50 |\n| Pear | 10 | 2.00 |';

  it('renders a header row and body rows', () => {
    const root = html(table);
    expect(root.querySelectorAll('thead th')).toHaveLength(3);
    expect(root.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(root.querySelector('tbody tr td')?.textContent).toBe('Apple');
  });

  it('applies column alignment', () => {
    const root = html(table);
    const cells = root.querySelectorAll<HTMLElement>('tbody tr:first-child td');
    expect(cells[1]?.style.textAlign).toBe('center');
    expect(cells[2]?.style.textAlign).toBe('right');
  });

  it('sits in a scrolling region so it stays usable on a narrow screen', () => {
    const wrapper = html(table).querySelector('.v-md__table') as HTMLElement;
    expect(wrapper.getAttribute('role')).toBe('region');
    expect(wrapper.getAttribute('tabindex')).toBe('0');
  });

  it('is only a paragraph until its delimiter row arrives (streaming)', () => {
    const root = html('| Name | Qty |');
    expect(root.querySelector('table')).toBeNull();
    expect(root.querySelectorAll('p')).toHaveLength(1);
  });

  it('keeps a pipe inside a code span in its own cell', () => {
    const root = html('| A | B |\n|---|---|\n| `x|y` | 2 |');
    const cells = root.querySelectorAll('tbody td');
    expect(cells).toHaveLength(2);
    expect(cells[0]?.querySelector('code')?.textContent).toBe('x|y');
  });

  it('pads a short row instead of dropping it', () => {
    const root = html('| a | b |\n| - | - |\n| only |');
    expect(root.querySelectorAll('tbody td')).toHaveLength(2);
  });
});

describe('links', () => {
  it('renders a Markdown link that opens safely in a new tab', () => {
    const anchor = html('[docs](https://example.com/a)').querySelector('a') as HTMLAnchorElement;
    expect(anchor.getAttribute('href')).toBe('https://example.com/a');
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(anchor.getAttribute('rel')).toContain('noopener');
  });

  it('links a bare URL but leaves the sentence punctuation out of it', () => {
    const anchor = html('See https://example.com/page, then go.').querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://example.com/page');
  });

  it('keeps a balanced closing parenthesis that is part of the address', () => {
    const anchor = html('https://en.wikipedia.org/wiki/Go_(game)').querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://en.wikipedia.org/wiki/Go_(game)');
  });

  it('allows a long address to wrap rather than overflow', () => {
    const long = `https://example.com/${'a'.repeat(300)}`;
    expect(html(long).querySelector('a')?.textContent).toBe(long);
  });
});

describe('safety', () => {
  it('never turns a script tag into an element', () => {
    const root = html('hello <script>window.__pwned = 1</script> world');
    expect(root.querySelector('script')).toBeNull();
    expect(root.textContent).toContain('<script>');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('never turns an img onerror payload into an element', () => {
    const root = html('<img src=x onerror="alert(1)">');
    expect(root.querySelector('img')).toBeNull();
  });

  it('drops a javascript: link target and keeps the words', () => {
    const root = html('[click me](javascript:alert(1))');
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toBe('click me');
  });

  it.each(['data:text/html,<b>x</b>', 'vbscript:run', 'file:///etc/passwd', '//evil.example/x'])(
    'refuses the link target %s',
    (target) => {
      expect(safeHref(target)).toBeNull();
    },
  );

  it('accepts http, https, mailto and relative targets', () => {
    expect(safeHref('https://a.example')).toBe('https://a.example');
    expect(safeHref('http://a.example')).toBe('http://a.example');
    expect(safeHref('mailto:a@b.example')).toBe('mailto:a@b.example');
    expect(safeHref('#section')).toBe('#section');
  });

  it('does not let a heading or a table cell carry markup', () => {
    const root = html('# <b>x</b>\n\n| <i>h</i> |\n| - |\n| <u>c</u> |');
    expect(root.querySelector('b, i, u')).toBeNull();
  });
});

describe('robustness', () => {
  it('never throws on unbalanced or hostile input', () => {
    const inputs = [
      '**',
      '*',
      '_',
      '__',
      '~~',
      '`',
      '```',
      '[',
      '[]',
      '[](',
      '[a](',
      ']()',
      '|',
      '|-|',
      '> ',
      '- ',
      '1. ',
      '#'.repeat(50),
      '*'.repeat(500),
      '['.repeat(200),
      '`'.repeat(99),
      '\u0000\u0001',
      '- '.repeat(300),
      '> '.repeat(100),
      'a|b\n-|-\n'.repeat(50),
    ];
    for (const input of inputs) {
      expect(() => parseMarkdown(input)).not.toThrow();
    }
  });

  it('parses a very long answer without losing its tail', () => {
    const body = Array.from({ length: 2000 }, (_, i) => `Paragraph ${i}.`).join('\n\n');
    const root = html(body);
    expect(root.querySelectorAll('p')).toHaveLength(2000);
    expect(root.textContent).toContain('Paragraph 1999.');
  });

  it('stays linear on a pathological emphasis run', () => {
    const started = Date.now();
    parseMarkdown('*a '.repeat(3000));
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("a person's own message (UserText)", () => {
  function bubble(text: string): HTMLElement {
    const { container } = render(
      <div data-testid="b">
        <UserText text={text} />
      </div>,
    );
    return container.firstElementChild as HTMLElement;
  }

  it('hands back exactly the characters typed, including blank lines and indentation', () => {
    const typed =
      'I want you to redesign my application.\n\nIMPORTANT:\n\n- Preserve existing functionality.\n  - nested\n- Keep the application name.';
    expect(bubble(typed).textContent).toBe(typed);
  });

  it('does not reinterpret dashes, hashes or asterisks as formatting', () => {
    const root = bubble('# not a heading\n- not a bullet\n**not bold**');
    expect(root.querySelector('h1, li, strong')).toBeNull();
    expect(root.textContent).toBe('# not a heading\n- not a bullet\n**not bold**');
  });

  it('shows a fenced block as code and keeps the prose around it', () => {
    const typed = 'before\n```sh\nnpm test\n```\nafter';
    const root = bubble(typed);
    expect(root.querySelector('pre code')?.textContent).toBe('npm test');
    expect(root.textContent).toContain('before');
    expect(root.textContent).toContain('after');
  });

  it('treats an unclosed fence as code to the end, losing nothing', () => {
    const segments = splitFences('x\n```\nstill typing');
    expect(segments.map((s) => s.kind)).toEqual(['text', 'code']);
    expect(segments[1]?.text).toBe('still typing');
  });

  it('links an address without changing the words around it', () => {
    const root = bubble('open https://example.com/x now.');
    expect(root.querySelector('a')?.getAttribute('href')).toBe('https://example.com/x');
    expect(root.textContent).toBe('open https://example.com/x now.');
  });

  it('never makes markup of angle brackets', () => {
    const root = bubble('<script>alert(1)</script><img src=x onerror=alert(1)>');
    expect(root.querySelector('script, img')).toBeNull();
    expect(root.textContent).toBe('<script>alert(1)</script><img src=x onerror=alert(1)>');
  });
});
