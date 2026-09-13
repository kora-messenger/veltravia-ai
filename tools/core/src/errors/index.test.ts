import { describe, expect, it } from 'vitest';
import {
  InvalidToolInputError,
  ToolConfirmationRejectedError,
  ToolNotFoundError,
  ToolOutputValidationError,
  ToolPermissionError,
  ToolUnavailableError,
  isToolError,
} from './index.js';

const FAKE_TOKENS = [
  'ghp_AbCdEf1234567890AbCdEf1234567890AbCd',
  'sk-proj-AbCdEf1234567890AbCdEf1234567890',
  'AIzaSyD-1234567890abcdefghij',
  'xoxb-123456789012-AbCdEfGhIjKl',
  'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
];

describe('tool errors', () => {
  it('carry stable codes', () => {
    expect(new ToolNotFoundError('ghost.tool').code).toBe('TOOL_NOT_FOUND');
    expect(new InvalidToolInputError('t', ['input.x: expected string, got number']).code).toBe(
      'INVALID_TOOL_INPUT',
    );
    expect(new ToolPermissionError('denied').code).toBe('TOOL_PERMISSION');
    expect(new ToolConfirmationRejectedError('t', 'c1').code).toBe('TOOL_CONFIRMATION_REJECTED');
    expect(new ToolUnavailableError('t', 'disabled').code).toBe('TOOL_UNAVAILABLE');
    expect(new ToolOutputValidationError('t', ['bad']).code).toBe('TOOL_OUTPUT_VALIDATION');
  });

  it('isToolError distinguishes tool errors from plain errors', () => {
    expect(isToolError(new ToolNotFoundError('x'))).toBe(true);
    expect(isToolError(new Error('plain'))).toBe(false);
  });

  it('toJSON is stack-free and structured', () => {
    const error = new ToolNotFoundError('ghost.tool');
    expect(error.toJSON()).toEqual({
      code: 'TOOL_NOT_FOUND',
      message: 'No tool registered with id "ghost.tool".',
      details: { toolId: 'ghost.tool' },
    });
    expect(JSON.stringify(error.toJSON())).not.toContain('at ');
  });

  it('input errors name fields, never values (inputs may contain secrets)', () => {
    const error = new InvalidToolInputError('mock.summarize', [
      'input.items: expected array, got string',
    ]);
    expect(error.message).not.toContain('the-secret-value');
    expect(JSON.stringify(error.details)).not.toContain('the-secret-value');
  });

  it('scrub secret-like values out of messages and details', () => {
    for (const token of FAKE_TOKENS) {
      const error = new ToolPermissionError(`request used ${token} without permission`, {
        detail: `saw ${token} in the input`,
      });
      expect(error.message).not.toContain(token);
      expect(JSON.stringify(error.details)).not.toContain(token);
      expect(JSON.stringify(error.toJSON())).not.toContain(token);
    }
  });

  it('keeps normal human text intact', () => {
    const error = new ToolUnavailableError(
      'mock.summarize',
      'the tool is disabled by the operator',
    );
    expect(error.message).toBe(
      'Tool "mock.summarize" is unavailable: the tool is disabled by the operator',
    );
  });
});
