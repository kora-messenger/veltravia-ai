import { readIntEnv } from '@veltravia/config';
import { buildApp } from './server.js';
import {
  DeploymentConfigError,
  assertDeploymentConfig,
  resolveDeploymentConfig,
} from './deployment/config.js';
import { createLogger } from './deployment/logger.js';
import { installGracefulShutdown } from './deployment/shutdown.js';
import { createDurableGatewayStores } from './deployment/durable-stores.js';

/**
 * Process entry point.
 *
 * Order matters: resolve and validate the configuration, refuse to start when it
 * is unsafe for the environment it claims to be in, then listen. A deployed API
 * that starts with a laptop configuration is worse than one that refuses to
 * start at all, because the failure only shows up later as missing data.
 */

const config = resolveDeploymentConfig();

try {
  assertDeploymentConfig(config);
} catch (error) {
  const problems = error instanceof DeploymentConfigError ? error.problems : ['unknown problem'];
  // Written to stderr directly: no logger exists yet, and this must be readable
  // in a platform's build log.
  console.error(`[veltravia-api] refusing to start (${config.mode}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(78); // EX_CONFIG
}

const log = createLogger(config);
for (const warning of config.warnings) log.warn(warning);

const durable =
  config.storageDriver === 'file' && config.dataDir !== null
    ? createDurableGatewayStores(config.dataDir)
    : null;

const app = buildApp({
  deployment: config,
  ...(durable === null
    ? {}
    : {
        gatewayStores: {
          vault: durable.vault,
          connections: durable.connections,
          preferences: durable.preferences,
          usage: durable.usage,
        },
        verifyStorage: durable.verify,
      }),
});

app
  .listen({ port: config.port, host: config.host })
  .then((address) => {
    log.info(
      {
        address,
        mode: config.mode,
        storage: config.storageDriver,
        corsOrigins: config.corsOrigins.length,
        credentialVault: config.hasCredentialKey,
      },
      'veltravia-api listening',
    );
  })
  .catch((error: unknown) => {
    log.error({ err: error instanceof Error ? { message: error.message } : error }, 'start failed');
    process.exit(1);
  });

installGracefulShutdown(app, {
  timeoutMs: readIntEnv('VELTRAVIA_SHUTDOWN_GRACE_MS', 10_000),
  log: (message) => log.info(message),
  exit: (code) => process.exit(code),
});
