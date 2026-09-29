import { describe, expect, it } from 'vitest';
import { ImageProviderRegistry } from './index.js';
import { IMAGE_PROVIDER_OPERATIONS } from '../types/index.js';
import type { ImageProvider, ImageProviderCapabilities } from '../types/index.js';

const caps = (providerId: string, capabilities: string[]): ImageProviderCapabilities => ({
  providerId,
  capabilities: capabilities as never,
  supportedFormats: null,
  maxBytes: null,
  maxDimensionPixels: null,
});

const provider = (id: string, capabilities: string[] = ['ocr']): ImageProvider => ({
  id,
  getCapabilities: () => caps(id, capabilities),
  analyze: async () => ({ text: '{}' }),
});

describe('image provider registry', () => {
  it('registers, lists, and looks up providers', () => {
    const r = new ImageProviderRegistry();
    const a = provider('prov-a');
    r.register(a);
    expect(r.list()).toHaveLength(1);
    expect(r.get('prov-a')).toBe(a);
    expect(r.get('missing')).toBeNull();
  });

  it('rejects structurally invalid providers', () => {
    const r = new ImageProviderRegistry();
    expect(() => r.register({} as never)).toThrow();
    expect(() =>
      r.register({
        id: '',
        analyze: async () => ({ text: '' }),
        getCapabilities: () => caps('', []),
      }),
    ).toThrow();
  });

  it('rejects duplicate provider ids on re-registration', () => {
    const r = new ImageProviderRegistry();
    r.register(provider('dup', ['ocr']));
    const second = provider('dup', ['ocr']);
    r.register(second);
    expect(r.get('dup')).toBe(second);
    expect(r.list()).toHaveLength(1);
  });

  it('resolves the first provider for a capability in registration order', () => {
    const r = new ImageProviderRegistry();
    r.register(provider('ocr-only', ['ocr']));
    r.register(provider('full', ['ocr', 'image_understanding']));
    expect(r.findForCapability('ocr')?.id).toBe('ocr-only');
    expect(r.findForCapability('image_understanding')?.id).toBe('full');
    expect(r.findForCapability('document_image_understanding')).toBeNull();
  });

  it('declares the closed operation union', () => {
    expect(IMAGE_PROVIDER_OPERATIONS).toHaveLength(9);
    expect(IMAGE_PROVIDER_OPERATIONS).toContain('describe');
  });
});
