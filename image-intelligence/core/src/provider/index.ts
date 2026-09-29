/** Provider registry: explicit registration, honest capability lookup.
 *  Registration grants nothing; the manager still re-checks every op. */
import { ImageIntelligenceError } from '../errors/index.js';
import type { ImageCapability, ImageProvider, ImageProviderCapabilities } from '../types/index.js';

export function isImageCapability(value: string): value is ImageCapability {
  return typeof value === 'string' && value.length > 0;
}

function validateCapabilities(c: ImageProviderCapabilities): ImageProviderCapabilities {
  if (!c || typeof c !== 'object') throw new Error('Invalid capabilities');
  if (typeof c.providerId !== 'string' || !c.providerId)
    throw new Error('Capabilities must declare a providerId');
  if (!Array.isArray(c.capabilities)) throw new Error('Capabilities must be an array');
  return c;
}

export class ImageProviderRegistry {
  private readonly providers = new Map<string, ImageProvider>();

  register(provider: ImageProvider): void {
    if (!provider || typeof provider !== 'object')
      throw new ImageIntelligenceError('IMAGE_INVALID_REQUEST', 'Invalid image provider.');
    if (typeof provider.id !== 'string' || provider.id.length === 0)
      throw new ImageIntelligenceError('IMAGE_INVALID_REQUEST', 'Provider id is required.');
    if (typeof provider.analyze !== 'function' || typeof provider.getCapabilities !== 'function')
      throw new ImageIntelligenceError('IMAGE_INVALID_REQUEST', 'Provider contract is invalid.');
    validateCapabilities(provider.getCapabilities());
    this.providers.set(provider.id, provider);
  }

  get(id: string): ImageProvider | null {
    return this.providers.get(id) ?? null;
  }

  list(): readonly ImageProvider[] {
    return [...this.providers.values()];
  }

  /** First registered provider (registration order) that declares the capability. */
  findForCapability(capability: ImageCapability): ImageProvider | null {
    for (const p of this.providers.values()) {
      if (p.getCapabilities().capabilities.includes(capability)) return p;
    }
    return null;
  }
}
