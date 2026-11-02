// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { UserAvatar, initialFrom } from './UserAvatar';

describe('the letter in the owner circle', () => {
  it('takes the first letter of the name and nothing else', () => {
    expect(initialFrom('Ijezie Nwosu')).toBe('I');
    expect(initialFrom('ijezie')).toBe('I');
    expect(initialFrom('Ada  Lovelace Byron')).toBe('A');
  });

  it('ignores leading spaces before deciding the first letter', () => {
    expect(initialFrom('   Nwosu')).toBe('N');
  });

  it('returns nothing when there is no name to take a letter from', () => {
    expect(initialFrom(null)).toBeNull();
    expect(initialFrom('   ')).toBeNull();
  });

  it('counts code points, so a name starting with an emoji still works', () => {
    expect(initialFrom('🎯 Goals')).toBe('🎯');
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

  it('draws one letter when there is no picture', () => {
    const { container } = render(<UserAvatar name="Ada Lovelace" />);
    expect(container.querySelector('.v-chat__avatar')?.textContent).toBe('A');
  });
});
