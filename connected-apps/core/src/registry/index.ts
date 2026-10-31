/** Provider registry. Registration validates descriptors and refuses duplicates
 *  or providers that claim a capability they do not implement. */
import { ConnectedAppError } from '../errors/index.js';
import { descriptorFor, providerImplements, type ConnectedAppProvider } from '../provider/index.js';
import type {
  ConnectedProviderId,
  ProviderCapability,
  ProviderDescriptor,
} from '../types/index.js';

export class ProviderRegistry {
  readonly #providers = new Map<ConnectedProviderId, ConnectedAppProvider>();

  register(provider: ConnectedAppProvider): void {
    const id = provider.descriptor.id;
    if (this.#providers.has(id))
      throw new ConnectedAppError(
        'CONNECTED_INVALID_REQUEST',
        `Provider ${id} is already registered.`,
      );
    const descriptor = descriptorFor(id, provider.descriptor);
    for (const capability of descriptor.capabilities)
      if (!providerImplements(provider, capability))
        throw new ConnectedAppError(
          'CONNECTED_INVALID_REQUEST',
          `Provider ${id} declares ${capability} but does not implement it.`,
        );
    // Store the provider itself: spreading it would drop prototype methods.
    this.#providers.set(id, provider);
  }

  has(id: string): id is ConnectedProviderId {
    return this.#providers.has(id as ConnectedProviderId);
  }

  get(id: string): ConnectedAppProvider {
    const provider = this.#providers.get(id as ConnectedProviderId);
    if (!provider)
      throw new ConnectedAppError('CONNECTED_PROVIDER_UNKNOWN', 'That provider is not available.');
    return provider;
  }

  descriptors(): readonly ProviderDescriptor[] {
    return [...this.#providers.values()]
      .map((provider) => provider.descriptor)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  supports(id: ConnectedProviderId, capability: ProviderCapability): boolean {
    return this.#providers.get(id)?.descriptor.capabilities.includes(capability) ?? false;
  }

  ids(): readonly ConnectedProviderId[] {
    return [...this.#providers.keys()];
  }
}
