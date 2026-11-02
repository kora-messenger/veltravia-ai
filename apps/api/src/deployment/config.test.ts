import { describe, expect, it } from 'vitest';
import {
  DeploymentConfigError,
  assertDeploymentConfig,
  resolveDeploymentConfig,
} from './config.js';

const staging = {
  NODE_ENV: 'staging',
  VELTRAVIA_PUBLIC_API_URL: 'https://api.example-staging.test',
  VELTRAVIA_CORS_ORIGINS: 'https://app.example-staging.test',
  VELTRAVIA_CREDENTIAL_KEY: 'a-key-that-exists',
  VELTRAVIA_STORAGE_DRIVER: 'file',
  VELTRAVIA_DATA_DIR: '/var/data',
};

describe('deployment configuration', () => {
  it('accepts a complete staging configuration', () => {
    const config = resolveDeploymentConfig({ env: staging });
    expect(config.problems).toEqual([]);
    expect(config.mode).toBe('staging');
    expect(config.requiresHttps).toBe(true);
    expect(config.storageDriver).toBe('file');
  });

  it('refuses to start without a public URL when remote', () => {
    const config = resolveDeploymentConfig({
      env: { ...staging, VELTRAVIA_PUBLIC_API_URL: '' },
    });
    expect(config.problems.join(' ')).toContain('VELTRAVIA_PUBLIC_API_URL');
    expect(() => assertDeploymentConfig(config)).toThrow(DeploymentConfigError);
  });

  it('refuses a plain-http public URL in a remote deployment', () => {
    const config = resolveDeploymentConfig({
      env: { ...staging, VELTRAVIA_PUBLIC_API_URL: 'http://api.example-staging.test' },
    });
    expect(config.problems.join(' ')).toContain('https');
  });

  it('refuses localhost as the public URL of a remote deployment', () => {
    const config = resolveDeploymentConfig({
      env: { ...staging, VELTRAVIA_PUBLIC_API_URL: 'https://localhost:3000' },
    });
    expect(config.problems.join(' ')).toContain('localhost');
  });

  it('never accepts a wildcard origin', () => {
    for (const mode of ['development', 'staging', 'production']) {
      const config = resolveDeploymentConfig({ env: { ...staging, NODE_ENV: mode } });
      const wildcard = resolveDeploymentConfig({
        env: { ...staging, NODE_ENV: mode, VELTRAVIA_CORS_ORIGINS: '*' },
      });
      expect(config.problems).toEqual([]);
      expect(wildcard.problems.join(' ')).toContain('never "*"');
    }
  });

  it('requires the web origin list for a remote deployment', () => {
    const config = resolveDeploymentConfig({
      env: { ...staging, VELTRAVIA_CORS_ORIGINS: '' },
    });
    expect(config.problems.join(' ')).toContain('VELTRAVIA_CORS_ORIGINS');
  });

  it('requires the credential key remotely and only warns locally', () => {
    const remote = resolveDeploymentConfig({
      env: { ...staging, VELTRAVIA_CREDENTIAL_KEY: '' },
    });
    expect(remote.problems.join(' ')).toContain('VELTRAVIA_CREDENTIAL_KEY');

    const local = resolveDeploymentConfig({
      env: { NODE_ENV: 'development', VELTRAVIA_CREDENTIAL_KEY: '' },
    });
    expect(local.problems).toEqual([]);
    expect(local.warnings.join(' ')).toContain('provider keys cannot be stored');
  });

  it('records that a secret is present without carrying its value', () => {
    const config = resolveDeploymentConfig({ env: staging });
    expect(config.hasCredentialKey).toBe(true);
    expect(JSON.stringify(config)).not.toContain(staging.VELTRAVIA_CREDENTIAL_KEY);
  });

  it('refuses file storage with nowhere to write', () => {
    const config = resolveDeploymentConfig({
      env: { ...staging, VELTRAVIA_DATA_DIR: '' },
    });
    expect(config.problems.join(' ')).toContain('VELTRAVIA_DATA_DIR');
  });

  it('warns that memory storage loses credentials remotely', () => {
    const config = resolveDeploymentConfig({
      env: { ...staging, VELTRAVIA_STORAGE_DRIVER: 'memory', VELTRAVIA_DATA_DIR: '' },
    });
    expect(config.warnings.join(' ')).toContain('lost on restart');
  });

  it('leaves a plain local run untouched', () => {
    const config = resolveDeploymentConfig({ env: {} });
    expect(config.mode).toBe('development');
    expect(config.problems).toEqual([]);
    expect(config.corsOrigins).toEqual([]);
    expect(config.storageDriver).toBe('memory');
  });

  it('does not believe forwarded headers by default', () => {
    expect(resolveDeploymentConfig({ env: {} }).trustProxy).toBe(false);
    expect(resolveDeploymentConfig({ env: { VELTRAVIA_TRUST_PROXY: 'true' } }).trustProxy).toBe(
      true,
    );
  });

  it('treats an unknown NODE_ENV as development rather than trusting it', () => {
    expect(resolveDeploymentConfig({ env: { NODE_ENV: 'prod-ish' } }).mode).toBe('development');
  });
});
