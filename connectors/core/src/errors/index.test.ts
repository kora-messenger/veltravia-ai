import { describe, expect, it } from 'vitest';
import { redactSecrets } from './index.js';
import {
  ConnectorAuthenticationError,
  ConnectorNotFoundError,
  ConnectorOperationError,
  ConnectorPermissionError,
  isConnectorError,
} from './index.js';

const FAKE_TOKENS = [
  'ghp_AbCdEf1234567890AbCdEf1234567890AbCd',
  'sk-proj-AbCdEf1234567890AbCdEf1234567890',
  'AIzaSyD-1234567890abcdefghij',
  'xoxb-123456789012-AbCdEfGhIjKl',
  'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
];

describe('connector errors', () => {
  it('ConnectorNotFoundError carries the code and a safe message', () => {
    const error = new ConnectorNotFoundError('missing-connector');
    expect(error.code).toBe('CONNECTOR_NOT_FOUND');
    expect(error.message).toContain('missing-connector');
    expect(isConnectorError(error)).toBe(true);
    expect(isConnectorError(new Error('plain'))).toBe(false);
  });

  it('toJSON is stack-free and structured', () => {
    const error = new ConnectorOperationError('c', 'op.run', 'exploded', {
      details: { reason: 'bad input' },
    });
    expect(error.toJSON()).toEqual({
      code: 'CONNECTOR_OPERATION',
      message: 'Operation "op.run" on connector "c" failed: exploded',
      details: { connectorId: 'c', operationId: 'op.run', reason: 'bad input' },
    });
    expect(JSON.stringify(error.toJSON())).not.toContain('at ');
  });

  it('redactSecrets strips every known token shape', () => {
    for (const token of FAKE_TOKENS) {
      expect(redactSecrets(`failed with token ${token} please retry`)).not.toContain(token);
    }
  });

  it('redactSecrets strips key: value assignments and long hex runs', () => {
    const scrubbed = redactSecrets('api_key: super-secret-value-123; token="abcdef12345"');
    expect(scrubbed).not.toContain('super-secret-value-123');
    expect(scrubbed).not.toContain('abcdef12345');
    expect(redactSecrets('hash deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).not.toContain(
      'deadbeef',
    );
  });

  it('errors scrub secret-like values out of their messages and details', () => {
    for (const token of FAKE_TOKENS) {
      const error = new ConnectorAuthenticationError('c', `provider said ${token} is invalid`);
      expect(error.message).not.toContain(token);
      const detailed = new ConnectorPermissionError('denied', {
        reason: `used ${token} without permission`,
      });
      expect(JSON.stringify(detailed.details)).not.toContain(token);
      expect(JSON.stringify(detailed.toJSON())).not.toContain(token);
    }
  });

  it('keeps normal human text intact', () => {
    const error = new ConnectorAuthenticationError('payments', 'the stored credential is revoked');
    expect(error.message).toBe(
      'Connector "payments" could not authenticate: the stored credential is revoked',
    );
    const message =
      'Connector "payments" could not authenticate: the stored credential is revoked.';
    expect(redactSecrets(message)).toBe(message);
  });
});
