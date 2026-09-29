import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  detectImageFormat,
  formatFromMime,
  parseAnimationInfo,
  parsePngInfo,
  regionId,
  elementId,
  svgHasScript,
  withinDimensionCeiling,
} from './index.js';

const read = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));

describe('image security helpers', () => {
  it('maps detected MIME types to formats', () => {
    expect(formatFromMime('image/png')).toBe('png');
    expect(formatFromMime('image/jpeg')).toBe('jpeg');
    expect(formatFromMime('image/jpg')).toBe('jpeg');
    expect(formatFromMime('image/webp')).toBe('webp');
    expect(formatFromMime('image/gif')).toBe('gif');
    expect(formatFromMime('image/tiff')).toBe('tiff');
    expect(formatFromMime('image/svg+xml')).toBe('svg');
    expect(formatFromMime('application/pdf')).toBeNull();
  });

  it('detects formats from magic bytes, never declarations', () => {
    expect(detectImageFormat(read('app.png'))).toBe('png');
    expect(detectImageFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('jpeg');
    expect(detectImageFormat(new Uint8Array([0x42, 0x4d, 0, 0, 0, 0]))).toBe('bmp');
    expect(detectImageFormat(new Uint8Array(32))).toBeNull();
  });

  it('parses PNG IHDR color info', () => {
    const rgb = parsePngInfo(read('app.png'));
    expect(rgb.bitDepth).toBe(8);
    expect(rgb.colorType).toBe(2);
    expect(rgb.hasAlpha).toBe(false);
    const rgba = parsePngInfo(read('purple.png'));
    expect(rgba.colorType).toBe(6);
    expect(rgba.hasAlpha).toBe(true);
    const short = parsePngInfo(new Uint8Array(10));
    expect(short.bitDepth).toBeNull();
    expect(short.colorType).toBeNull();
    expect(short.hasAlpha).toBe(false);
  });

  it('parses animation info honestly per container', () => {
    const gif = parseAnimationInfo(read('anim.gif'), 'gif');
    expect(gif.animated).toBe(true);
    expect(gif.frameCount).not.toBeNull();
    expect(gif.frameCount!).toBeGreaterThan(1);
    const png = parseAnimationInfo(read('app.png'), 'png');
    expect(png.animated).toBeNull();
    expect(png.frameCount).toBeNull();
  });

  it('flags script-bearing SVG as unsafe', () => {
    expect(svgHasScript(read('icon.svg'))).toBe(true);
    expect(
      svgHasScript(new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))),
    ).toBe(false);
  });

  it('enforces the dimension ceiling', () => {
    expect(withinDimensionCeiling(100, 200, 10_000)).toBe(true);
    expect(withinDimensionCeiling(20_000, 100, 10_000)).toBe(false);
    expect(withinDimensionCeiling(null, null, 10_000)).toBe(true);
  });

  it('derives deterministic region and element ids', () => {
    expect(regionId('abc', 0)).toBe(regionId('abc', 0));
    expect(regionId('abc', 0)).not.toBe(regionId('abc', 1));
    expect(elementId('abc', 0)).not.toBe(regionId('abc', 0));
  });
});
