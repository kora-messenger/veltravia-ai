/**
 * Network policy - disabled by default, allowlist only.
 *
 * Unrestricted internet access does not exist as a policy state. A sandbox
 * either has no network at all (default) or a small, explicitly declared
 * destination allowlist. Destinations are hostnames (optionally with a
 * `*.domain` subdomain group and a port) - never URLs, never IP schemes,
 * never "any host".
 */

import { NetworkPolicyRejectedError } from '../errors/index.js';
import type { NetworkDestination, NetworkPolicy } from '../types/index.js';

const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const WILDCARD_HOST_PATTERN = /^\*\.(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const MAX_DESTINATIONS = 16;
const HOST_MAX_LENGTH = 253;

/** Validates one allowlist destination. */
export function validateNetworkDestination(destination: NetworkDestination): NetworkDestination {
  if (typeof destination !== 'object' || destination === null || Array.isArray(destination)) {
    throw new NetworkPolicyRejectedError('destinations must be objects', { reason: 'not-an-object' });
  }
  const { host, port } = destination;
  if (typeof host !== 'string' || host.length === 0) {
    throw new NetworkPolicyRejectedError('destination host must be a non-empty string', {
      reason: 'empty-host',
    });
  }
  if (host.length > HOST_MAX_LENGTH) {
    throw new NetworkPolicyRejectedError('destination host is too long', { reason: 'too-long' });
  }
  if (host.includes('/') || host.includes(':')) {
    throw new NetworkPolicyRejectedError(
      'destination host must be a bare hostname - URLs, schemes, and userinfo are rejected',
      { reason: 'url-like' },
    );
  }
  if (!HOST_PATTERN.test(host) && !WILDCARD_HOST_PATTERN.test(host)) {
    throw new NetworkPolicyRejectedError('destination host is not a valid hostname', {
      reason: 'invalid-host',
    });
  }
  if (port !== undefined) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new NetworkPolicyRejectedError('destination port must be an integer in 1-65535', {
        reason: 'invalid-port',
      });
    }
  }
  return port === undefined ? { host } : { host, port };
}

/** Validates a full network policy (creation time + runtime re-checks). */
export function validateNetworkPolicy(policy: NetworkPolicy): NetworkPolicy {
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
    throw new NetworkPolicyRejectedError('network policy must be an object', {
      reason: 'not-an-object',
    });
  }
  if (policy.mode !== 'disabled' && policy.mode !== 'allowlist') {
    throw new NetworkPolicyRejectedError(
      'network mode must be "disabled" or "allowlist" - unrestricted access does not exist',
      { reason: 'invalid-mode', mode: String(policy.mode) },
    );
  }
  const destinations = policy.allowedDestinations ?? [];
  if (!Array.isArray(destinations)) {
    throw new NetworkPolicyRejectedError('allowedDestinations must be an array', {
      reason: 'not-an-array',
    });
  }
  if (policy.mode === 'disabled' && destinations.length > 0) {
    throw new NetworkPolicyRejectedError(
      'a disabled network policy must not declare destinations',
      { reason: 'destinations-with-disabled' },
    );
  }
  if (policy.mode === 'allowlist' && destinations.length === 0) {
    throw new NetworkPolicyRejectedError(
      'allowlist mode requires at least one explicitly declared destination',
      { reason: 'empty-allowlist' },
    );
  }
  if (destinations.length > MAX_DESTINATIONS) {
    throw new NetworkPolicyRejectedError(
      `allowedDestinations must not exceed ${MAX_DESTINATIONS} entries`,
      { reason: 'too-many', limit: MAX_DESTINATIONS },
    );
  }
  const validated = destinations.map(validateNetworkDestination);
  const seen = new Set<string>();
  for (const destination of validated) {
    const key = `${destination.host}:${destination.port ?? '*'}`;
    if (seen.has(key)) {
      throw new NetworkPolicyRejectedError('duplicate destination in network policy', {
        reason: 'duplicate',
      });
    }
    seen.add(key);
  }
  return {
    mode: policy.mode,
    allowedDestinations: validated.map((destination) => ({ ...destination })),
  };
}

/**
 * Policy check used before every execution: the runtime receives the
 * sandbox's creation-time policy and can never be handed a different one -
 * execution requests have no network fields at all.
 */
export function assertExecutionNetworkPolicy(sandboxPolicy: NetworkPolicy): void {
  validateNetworkPolicy(sandboxPolicy);
}
