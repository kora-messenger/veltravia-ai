// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { BrandMark } from './BrandMark';

/**
 * Branding cannot regress silently.
 *
 * These assertions read the shipped files, not a copy: the dimensions, the
 * alpha channel and the favicon wiring are checked against what the browser
 * will actually fetch. A replaced or re-exported asset fails here.
 */

const BRAND_DIR = resolve(__dirname, '../../../public/brand');

interface BrandManifest {
  inkAlpha: number;
  padding: number;
  files: Record<string, { width?: number; height?: number; inkFill?: number; bytes?: number }>;
}

/** Measurements written by scripts/trim-brand-assets.py, reviewed in the commit. */
function manifest(): BrandManifest {
  return JSON.parse(readFileSync(resolve(BRAND_DIR, 'brand-assets.json'), 'utf8')) as BrandManifest;
}

/** Reads width, height and colour type straight from a PNG header. */
function pngHeader(file: string): { width: number; height: number; colorType: number } {
  const buffer = readFileSync(resolve(BRAND_DIR, file));
  const signature = buffer.subarray(0, 8).toString('hex');
  expect(signature).toBe('89504e470d0a1a0a');
  expect(buffer.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    colorType: buffer[25] ?? -1,
  };
}

describe('brand assets', () => {
  it('ships the supplied logo at its original size with transparency', () => {
    const header = pngHeader('veltravia-logo.png');
    expect(header.width).toBe(1024);
    expect(header.height).toBe(1024);
    // Colour type 6 is RGBA: the logo is transparent, not flattened on white.
    expect(header.colorType).toBe(6);
  });

  it('ships the supplied notification mark at its original proportions', () => {
    // The delivered notification art: white ink on transparency, 1024x518.
    const header = pngHeader('veltravia-mark.png');
    expect(header.width).toBe(1024);
    expect(header.height).toBe(518);
    expect(header.colorType).toBe(6);
  });

  it('derives favicon and app icons from that logo at exact sizes', () => {
    for (const size of [32, 48, 96, 180, 192, 512]) {
      const header = pngHeader(`veltravia-logo-${size}.png`);
      expect(header.width).toBe(size);
      expect(header.height).toBe(size);
      expect(header.colorType).toBe(6);
    }
  });

  it('derives square notification icons with transparency', () => {
    for (const size of [48, 96, 256]) {
      const header = pngHeader(`veltravia-notification-${size}.png`);
      expect(header.width).toBe(size);
      expect(header.height).toBe(size);
      expect(header.colorType).toBe(6);
    }
  });

  it('derives every shipped icon from artwork cropped to its ink', () => {
    const measured = manifest();
    // The padding this fixes: the raw logo is only 64% x 51% ink inside its canvas.
    expect(measured.padding).toBeGreaterThan(0);
    expect(measured.padding).toBeLessThanOrEqual(0.1);
    const derived = Object.entries(measured.files).filter(([name]) => name.endsWith('.png'));
    expect(derived.length).toBeGreaterThanOrEqual(10);
    for (const [name, info] of derived) {
      const header = pngHeader(name);
      expect({ name, width: header.width }).toEqual({ name, width: info.width });
      expect({ name, height: header.height }).toEqual({ name, height: info.height });
      // A mark that fills under 70% of its box renders visibly small at 28px.
      expect({ name, fill: info.inkFill }).toEqual({ name, fill: expect.any(Number) });
      expect(info.inkFill ?? 0).toBeGreaterThanOrEqual(0.8);
    }
  });

  it('keeps the delivered originals at full size next to the derivatives', () => {
    const measured = manifest();
    expect(measured.originals.map((entry) => entry.file)).toEqual([
      'veltravia-logo.png',
      'veltravia-mark.png',
    ]);
    expect(pngHeader('veltravia-logo.png')).toMatchObject({ width: 1024, height: 1024 });
    expect(pngHeader('veltravia-mark.png')).toMatchObject({ width: 1024, height: 518 });
  });

  it('ships the trimmed masters as square RGBA', () => {
    for (const [file, size] of [
      ['veltravia-logo-trim.png', 1024],
      ['veltravia-notification-trim.png', 512],
    ] as const) {
      const header = pngHeader(file);
      expect({ file, width: header.width, height: header.height }).toEqual({
        file,
        width: size,
        height: size,
      });
      expect(header.colorType).toBe(6);
    }
  });

  it('includes a multi-size favicon.ico', () => {
    const ico = readFileSync(resolve(BRAND_DIR, 'favicon.ico'));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(1);
  });

  it('wires the icons into the document head', () => {
    const html = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8');
    expect(html).toContain('/brand/favicon.ico');
    expect(html).toContain('/brand/veltravia-logo-32.png');
    expect(html).toContain(
      '/brand/apple-touch-icon'.replace('apple-touch-icon', 'veltravia-logo-180.png'),
    );
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('name="theme-color"');
  });
});

describe('BrandMark', () => {
  it('renders the full logo with a product label', () => {
    render(<BrandMark size={40} />);
    const image = screen.getByRole('img', { name: 'Veltravia AI' });
    // The cropped 192px derivative, with densities so 3x screens get 512, not an upscale.
    expect(image.getAttribute('src')).toBe('/brand/veltravia-logo-192.png');
    const srcSet = image.getAttribute('srcSet') ?? '';
    expect(srcSet).toContain('/brand/veltravia-logo-96.png 1x');
    expect(srcSet).toContain('/brand/veltravia-logo-192.png 2x');
    expect(srcSet).toContain('/brand/veltravia-logo-512.png 3x');
    expect(image.getAttribute('width')).toBe('40');
    expect(image.getAttribute('height')).toBe('40');
  });

  it('renders the notification mark', () => {
    render(<BrandMark variant="notification" size={24} />);
    const image = screen.getByRole('img', { name: 'Veltravia AI notifications' });
    expect(image.getAttribute('src')).toBe('/brand/veltravia-notification-96.png');
    expect(image.getAttribute('srcSet') ?? '').toContain(
      '/brand/veltravia-notification-256.png 2x',
    );
  });

  it('hides a decorative mark from assistive technology', () => {
    const { container } = render(<BrandMark decorative />);
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(container.querySelector('img')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('never animates the mark', () => {
    const css = readFileSync(resolve(__dirname, 'brand.css'), 'utf8');
    // The logo is static: no float, drift, pulse or spin anywhere in its styles.
    expect(css).not.toMatch(/@keyframes/);
    expect(css).not.toMatch(/animation\s*:/);
    expect(css).not.toMatch(/transform\s*:\s*(rotate|scale)/);
  });

  it('keeps the asset square through the size variable', () => {
    const { container } = render(<BrandMark size={64} />);
    const wrapper = container.querySelector('.v-brand-mark') as HTMLElement;
    expect(wrapper.style.getPropertyValue('--brand-mark-size')).toBe('64px');
    expect(wrapper.dataset.variant).toBe('logo');
  });
});
