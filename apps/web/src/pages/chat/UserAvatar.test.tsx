// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { UserAvatar, initialsFrom } from './UserAvatar';

describe('the initials in the owner circle', () => {
  it('uses the first and last word, upper-cased', () => {
    expect(initialsFrom('Ijezie Nwosu')).toBe('IN');
    expect(initialsFrom('ijezie')).toBe('I');
    expect(initialsFrom('Ada  Lovelace Byron')).toBe('AB');
  });

  it('returns nothing when there is no name to take letters from', () => {
    expect(initialsFrom(null)).toBeNull();
    expect(initialsFrom('   ')).toBeNull();
  });

  it('counts code points, so a name starting with an emoji still works', () => {
    expect(initialsFrom('🎯 Goals')).toBe('🎯G');
  });
});

describe('the owner circle', () => {
  it('shows a picture when one exists, and never announces itself', () => {
    const { container } = render(<UserAvatar name="Ada Lovelace" src="/me.png" />);
    const avatar = container.querySelector('.v-chat__avatar');
    expect(avatar?.getAttribute('aria-hidden')).toBe('true');
    expect(avatar?.querySelector('img')?.getAttribute('src')).toBe('/me.png');
    // The picture is the whole circle, so no initials sit behind it.
    expect(avatar?.textContent).toBe('');
  });

  it('draws the initials when there is no picture', () => {
    const { container } = render(<UserAvatar name="Ada Lovelace" />);
    expect(container.querySelector('.v-chat__avatar')?.textContent).toBe('AL');
  });
});
