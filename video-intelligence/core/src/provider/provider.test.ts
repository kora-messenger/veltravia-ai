import { describe, it, expect } from 'vitest';
import { VideoProviderRegistry } from './index.js';
import { createMockVideoProvider } from '@veltravia/video-intelligence-mock';
describe('video registry', () => {
  it('rejects duplicate registration', () => {
    const r = new VideoProviderRegistry();
    const p = createMockVideoProvider();
    r.register(p);
    expect(() => r.register(p)).toThrow();
  });
  it('rejects unknown capabilities', () => {
    const r = new VideoProviderRegistry();
    const p = createMockVideoProvider();
    expect(() =>
      r.register({
        ...p,
        getCapabilities: () => ({ ...p.getCapabilities(), capabilities: ['guess'] as never }),
      }),
    ).toThrow();
  });
  it('registration does not invent unsupported provider', () => {
    expect(new VideoProviderRegistry().findForCapability('ocr')).toBeNull();
  });
});
