import { describe, expect, it } from 'vitest';
import { normalizeToolResult, createDeniedToolResult } from './index.js';

describe('normalizeToolResult', () => {
  it('maps a Tool System success result into the agent-level shape', () => {
    const result = normalizeToolResult({
      invocationId: 'inv-1',
      toolId: 'mock.summarize',
      correlationId: 'run-1',
      status: 'success',
      output: { text: 'a b', count: 2 },
      requestedAt: '2026-09-13T16:00:00.000Z',
      completedAt: '2026-09-13T16:00:01.000Z',
    });
    expect(result).toEqual({
      invocationId: 'inv-1',
      toolId: 'mock.summarize',
      correlationId: 'run-1',
      status: 'success',
      output: { text: 'a b', count: 2 },
      requestedAt: '2026-09-13T16:00:00.000Z',
      completedAt: '2026-09-13T16:00:01.000Z',
    });
  });

  it('maps denial and failure results with their typed errors', () => {
    const denied = normalizeToolResult({
      invocationId: 'inv-2',
      toolId: 'mock.summarize',
      status: 'denied',
      error: { code: 'TOOL_PERMISSION', message: 'missing granted permissions' },
      requestedAt: 'x',
      completedAt: 'y',
    });
    expect(denied.status).toBe('denied');
    expect(denied.error).toEqual({
      code: 'TOOL_PERMISSION',
      message: 'missing granted permissions',
    });
    expect(denied.output).toBeUndefined();
  });

  it('carries the confirmation id for awaiting_confirmation results', () => {
    const paused = normalizeToolResult({
      invocationId: 'inv-3',
      toolId: 'mock.purge',
      status: 'awaiting_confirmation',
      requestedAt: 'x',
      completedAt: 'y',
      confirmationId: 'conf-1',
    });
    expect(paused.confirmationId).toBe('conf-1');
  });
});

describe('createDeniedToolResult', () => {
  it('builds a denial for externally-decided outcomes (e.g. human rejection)', () => {
    const result = createDeniedToolResult({
      invocationId: 'inv-3',
      toolId: 'mock.purge',
      code: 'TOOL_PERMISSION',
      message: 'The human operator rejected the confirmation for this tool request.',
      requestedAt: 'x',
      completedAt: 'y',
    });
    expect(result.status).toBe('denied');
    expect(result.error?.message).toContain('rejected');
  });
});
