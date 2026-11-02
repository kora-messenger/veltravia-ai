import type { FastifyInstance } from 'fastify';
import { formatTimestamp } from '@veltravia/shared';
import { VELTRAVIA_NAME, VELTRAVIA_VERSION } from '@veltravia/types';
import type { DeploymentConfig } from '../deployment/config.js';

/**
 * Liveness and readiness.
 *
 * `/health` answers "is this process alive": it never touches a dependency, so a
 * load balancer can restart a wedged instance without waiting.
 * `/ready` answers "can this process do its job": each dependency is checked and
 * a failed one turns the whole answer into 503 so traffic stops arriving.
 *
 * Neither answer names an environment variable, a credential, a connection
 * string, a filesystem path or a version of anything private. A check reports a
 * verdict and a sentence written for a person.
 */

export interface HealthCheck {
  readonly name: string;
  readonly status: 'ok' | 'fail';
  /** Plain words, never a path or a value. */
  readonly detail?: string;
}

export interface ReadinessDependencies {
  /** Verifies durable storage is writable when one is configured. */
  readonly verifyStorage?: () => Promise<void>;
  /** Verifies anything else the deployment depends on. */
  readonly extra?: readonly { readonly name: string; readonly check: () => Promise<void> }[];
}

export function registerHealthRoutes(
  app: FastifyInstance,
  options: { readonly config: DeploymentConfig; readonly dependencies?: ReadinessDependencies },
): void {
  const { config } = options;
  const startedAt = Date.now();

  app.get('/health', async () => ({
    status: 'ok',
    service: `${VELTRAVIA_NAME} API`,
    version: VELTRAVIA_VERSION,
    timestamp: formatTimestamp(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    mode: config.mode,
  }));

  app.get('/ready', async (_request, reply) => {
    const checks: HealthCheck[] = [];

    // 1. Configuration: a problem found at boot is a problem now.
    checks.push(
      config.problems.length === 0
        ? { name: 'configuration', status: 'ok' }
        : {
            name: 'configuration',
            status: 'fail',
            detail: `${config.problems.length} configuration problem(s) found at startup`,
          },
    );

    // 2. Credential encryption, without saying whether a key exists as a value.
    checks.push(
      config.hasCredentialKey
        ? { name: 'credential-encryption', status: 'ok' }
        : { name: 'credential-encryption', status: 'ok', detail: 'not configured' },
    );

    // 3. Durable storage, only when the deployment claims to have some.
    if (config.storageDriver === 'file') {
      const verify =
        options.dependencies?.verifyStorage ??
        (async () => {
          throw new Error('no storage verifier is wired');
        });
      try {
        await verify();
        checks.push({ name: 'storage', status: 'ok' });
      } catch {
        checks.push({
          name: 'storage',
          status: 'fail',
          detail: 'durable storage could not be written',
        });
      }
    }

    // 4. Anything else the deployment depends on.
    for (const dependency of options.dependencies?.extra ?? []) {
      try {
        await dependency.check();
        checks.push({ name: dependency.name, status: 'ok' });
      } catch {
        checks.push({
          name: dependency.name,
          status: 'fail',
          detail: 'dependency is not answering',
        });
      }
    }

    const ready = checks.every((check) => check.status === 'ok');
    void reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not-ready',
      service: `${VELTRAVIA_NAME} API`,
      version: VELTRAVIA_VERSION,
      timestamp: formatTimestamp(),
      checks,
    });
  });
}
