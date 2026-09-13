import { describe, expect, it } from 'vitest';
import {
  AgentError,
  AgentNotAllowedError,
  AgentRunNotFoundError,
  AgentRunTerminalError,
  InvalidAgentLimitsError,
  InvalidAgentRequestError,
  isAgentError,
  scrubAgentSecrets,
} from './index.js';

const FAKE_TOKENS = [
  'ghp_AbCdEf1234567890AbCdEf1234567890AbCd',
  'sk-proj-AbCdEf1234567890AbCdEf1234567890',
  'AIzaSyD-1234567890abcdefghij',
  'xoxb-123456789012-AbCdEfGhIjKl',
  'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
];

describe('agent errors', () => {
  it('carry stable codes', () => {
    expect(new AgentRunNotFoundError('r1').code).toBe('AGENT_RUN_NOT_FOUND');
    expect(new AgentRunTerminalError('r1', 'completed', 'cancel it').code).toBe(
      'AGENT_RUN_TERMINAL',
    );
    expect(new AgentNotAllowedError('nope').code).toBe('AGENT_NOT_ALLOWED');
    expect(new InvalidAgentLimitsError(['x']).code).toBe('AGENT_LIMITS_INVALID');
    expect(new InvalidAgentRequestError(['x']).code).toBe('AGENT_INVALID_REQUEST');
  });

  it('isAgentError distinguishes agent errors', () => {
    expect(isAgentError(new AgentError('AGENT_NOT_ALLOWED', 'x'))).toBe(true);
    expect(isAgentError(new Error('plain'))).toBe(false);
  });

  it('toJSON is structured and stack-free', () => {
    const error = new AgentRunNotFoundError('run-42');
    expect(error.toJSON()).toEqual({
      code: 'AGENT_RUN_NOT_FOUND',
      message: 'No agent run with id "run-42".',
      details: { runId: 'run-42' },
    });
    expect(JSON.stringify(error.toJSON())).not.toContain('at ');
  });

  it('scrubs secret-shaped values from messages and details', () => {
    for (const token of FAKE_TOKENS) {
      const error = new AgentNotAllowedError(`the task mentioned ${token}`, {
        details: { note: `saw ${token} in the request` },
      });
      expect(error.message).not.toContain(token);
      expect(JSON.stringify(error.details ?? {})).not.toContain(token);
      expect(JSON.stringify(error.toJSON())).not.toContain(token);
    }
  });

  it('scrubAgentSecrets keeps normal text intact', () => {
    expect(scrubAgentSecrets('the agent requested tool mock.summarize')).toBe(
      'the agent requested tool mock.summarize',
    );
    expect(scrubAgentSecrets('api_key=ghp_AbCdEf1234567890AbCdEf1234567890AbCd')).not.toContain(
      'ghp_',
    );
  });
});
