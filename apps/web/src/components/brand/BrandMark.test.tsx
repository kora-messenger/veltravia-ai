// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { BrandMark, brandUrl } from './BrandMark';

/**
 * The mark is a file in `public/`, so its URL is written by hand and the
 * bundler does not rewrite it. That is how the deployed site ended up asking
 * the server root for a file that only exists under `/veltravia-ai/`: the
 * request 404'd and the mark rendered as a broken image. These tests pin the
 * URL to the folder the page is actually served from.
 */
const PAGES = 'https://kora-messenger.github.io/veltravia-ai/';

function image(container: HTMLElement): HTMLImageElement {
  const img = container.querySelector('img');
  if (img === null) throw new Error('the mark rendered no image');
  return img;
}

describe('brand file URLs', () => {
  it('lands inside the deployed folder rather than at the server root', () => {
    expect(brandUrl('veltravia-logo-192.png', PAGES)).toBe(`${PAGES}brand/veltravia-logo-192.png`);
  });

  it('still lands inside it when the base arrives without its trailing slash', () => {
    expect(brandUrl('veltravia-logo-192.png', 'https://example.test/site')).toBe(
      'https://example.test/site/brand/veltravia-logo-192.png',
    );
  });

  it('asks the root in development, where the page is served from /', () => {
    expect(brandUrl('veltravia-logo-192.png', 'http://localhost:5173/')).toBe(
      'http://localhost:5173/brand/veltravia-logo-192.png',
    );
  });
});

describe('the rendered mark', () => {
  it('draws the logo and its 1x/2x/3x files from the page folder', () => {
    const { container } = render(<BrandMark decorative />);
    const img = image(container);
    expect(img.getAttribute('src')).toBe(brandUrl('veltravia-logo-192.png', document.baseURI));
    expect(img.getAttribute('srcset')).toBe(
      [
        `${brandUrl('veltravia-logo-96.png', document.baseURI)} 1x`,
        `${brandUrl('veltravia-logo-192.png', document.baseURI)} 2x`,
        `${brandUrl('veltravia-logo-512.png', document.baseURI)} 3x`,
      ].join(', '),
    );
  });

  it('draws the notification mark from its own files', () => {
    const { container } = render(<BrandMark variant="notification" decorative />);
    const img = image(container);
    expect(img.getAttribute('src')).toBe(
      brandUrl('veltravia-notification-96.png', document.baseURI),
    );
  });

  it('names the product for a screen reader unless it is decorative', () => {
    const spoken = render(<BrandMark />);
    expect(image(spoken.container).getAttribute('alt')).toBe('Veltravia AI');
    const silent = render(<BrandMark decorative />);
    expect(image(silent.container).getAttribute('alt')).toBe('');
  });
});
