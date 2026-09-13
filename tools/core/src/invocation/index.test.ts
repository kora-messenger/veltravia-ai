import { describe, expect, it } from 'vitest';
import { createToolInvocation, createToolInvocationResult } from './index.js';

describe('createToolInvocation', () => {
  it('records the AI request with no authority of its own', () => {
    const invocation = createToolInvocation({
      toolId: 'mock.summarize',
      input: { items: ['a', 'b'] },
      requester: 'test-harness',
      correlationId: 'conv-42',
    });
    expect(invocation.toolId).toBe('mock.summarize');
    expect(invocation.requester).toBe('test-harness');
    expect(invocation.confirmationState).toBe('not_required');
    expect(invocation.correlationId).toBe('conv-42');
    expect(invocation.input).toEqual({ items: ['a', 'b'] });
    expect(typeof invocation.id).toBe('string');
    expect(typeof invocation.requestedAt).toBe('string');
  });

  it('records requested (claimed) permissions without granting them', () => {
    const invocation = createToolInvocation({
      toolId: 't',
      input: {},
      requester: 'ai',
      requestedPermissions: ['mock.admin'],
    });
    expect(invocation.requestedPermissions).toEqual(['mock.admin']);
    // The claim is pure data - the executor re-checks real grants.
  });

  it('validates its inputs', () => {
    expect(() => createToolInvocation({ toolId: '', input: {}, requester: 'r' })).toThrow(/toolId/);
    expect(() =>
      createToolInvocation({ toolId: 't', input: 'nope' as never, requester: 'r' }),
    ).toThrow(/input/);
    expect(() => createToolInvocation({ toolId: 't', input: {}, requester: ' ' })).toThrow(
      /requester/,
    );
  });
});

describe('createToolInvocationResult', () => {
  it('builds a normalized success result', () => {
    const result = createToolInvocationResult({
      invocationId: 'inv-1',
      toolId: 'mock.summarize',
      correlationId: 'conv-42',
      status: 'success',
      output: { text: 'a b', count: 2 },
      requestedAt: '2026-09-13T15:00:00.000Z',
      completedAt: '2026-09-13T15:00:01.000Z',
    });
    expect(result.status).toBe('success');
    expect(result.output).toEqual({ text: 'a b', count: 2 });
    expect(result.error).toBeUndefined();
  });

  it('builds a normalized denied result with a typed error', () => {
    const result = createToolInvocationResult({
      invocationId: 'inv-1',
      toolId: 'mock.summarize',
      status: 'denied',
      error: { code: 'TOOL_PERMISSION', message: 'missing granted permissions' },
      requestedAt: '2026-09-13T15:00:00.000Z',
      completedAt: '2026-09-13T15:00:01.000Z',
    });
    expect(result.error).toEqual({
      code: 'TOOL_PERMISSION',
      message: 'missing granted permissions',
    });
    expect(result.output).toBeUndefined();
  });

  it('builds an awaiting_confirmation result tied to its confirmation', () => {
    const result = createToolInvocationResult({
      invocationId: 'inv-1',
      toolId: 'mock.purge',
      status: 'awaiting_confirmation',
      requestedAt: '2026-09-13T15:00:00.000Z',
      completedAt: '2026-09-13T15:00:01.000Z',
      confirmationId: 'conf-1',
    });
    expect(result.confirmationId).toBe('conf-1');
  });

  it('validates its inputs', () => {
    expect(() =>
      createToolInvocationResult({
        invocationId: '',
        toolId: 't',
        status: 'success',
        output: {},
        requestedAt: 'x',
        completedAt: 'y',
      }),
    ).toThrow(/invocationId/);
    expect(() =>
      createToolInvocationResult({
        invocationId: 'i',
        toolId: 't',
        status: 'success',
        requestedAt: 'x',
        completedAt: 'y',
      }),
    ).toThrow(/output/);
    expect(() =>
      createToolInvocationResult({
        invocationId: 'i',
        toolId: 't',
        status: 'banana' as never,
        requestedAt: 'x',
        completedAt: 'y',
      }),
    ).toThrow(/status/);
  });
});
