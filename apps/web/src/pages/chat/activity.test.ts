import { describe, expect, it } from 'vitest';
import { formatDuration, shorten } from './activity';

describe('shorten', () => {
  it('collapses whitespace and keeps short labels intact', () => {
    expect(shorten('  read   the test  tail ')).toBe('read the test tail');
  });

  it('trims a long label at a word boundary with an ellipsis', () => {
    const long = `${'word '.repeat(40)}end`;
    expect(shorten(long).length).toBeLessThanOrEqual(80);
    expect(shorten(long).endsWith('…')).toBe(true);
    const words = shorten(long);
    expect(words.endsWith('…')).toBe(true);
    expect(words).not.toContain('  ');
  });
});

describe('formatDuration', () => {
  it('reads milliseconds below a second and seconds above', () => {
    expect(formatDuration(320)).toBe('320 ms');
    expect(formatDuration(1450)).toBe('1.5 s');
  });

  it('rounds to whole seconds once a run is long enough', () => {
    expect(formatDuration(12_400)).toBe('12 s');
  });

  it('refuses to format something that is not a duration', () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(-1)).toBeNull();
    expect(formatDuration(Number.NaN)).toBeNull();
  });
});
