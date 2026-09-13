import { describe, expect, it } from 'vitest';
import { defineOperation, operationRequiresConfirmation } from './index.js';

const LOW = { id: 'data.read', riskLevel: 'low' };
const HIGH = { id: 'data.write', riskLevel: 'high' };
const CRITICAL = { id: 'data.delete', riskLevel: 'critical' };

describe('operations', () => {
  it('defines a valid operation declaration', () => {
    const operation = defineOperation({
      id: 'example.read',
      name: 'Read Resource',
      description: 'Reads a resource',
      requiredPermissions: ['data.read'],
      inputSchema: { type: 'object' },
      requiresConfirmation: false,
    });
    expect(operation).toMatchObject({
      id: 'example.read',
      name: 'Read Resource',
      requiredPermissions: ['data.read'],
      requiresConfirmation: false,
    });
  });

  it('rejects malformed declarations', () => {
    expect(() =>
      defineOperation({
        id: 'Bad Op',
        name: 'x',
        description: 'x',
        requiredPermissions: ['p'],
        requiresConfirmation: false,
      }),
    ).toThrow(/dot\/dash/);
    expect(() =>
      defineOperation({
        id: 'ok.read',
        name: '',
        description: 'x',
        requiredPermissions: ['p'],
        requiresConfirmation: false,
      }),
    ).toThrow(/name/);
    expect(() =>
      defineOperation({
        id: 'ok.read',
        name: 'x',
        description: '',
        requiredPermissions: ['p'],
        requiresConfirmation: false,
      }),
    ).toThrow(/description/);
    expect(() =>
      defineOperation({
        id: 'ok.read',
        name: 'x',
        description: 'x',
        requiredPermissions: [],
        requiresConfirmation: false,
      }),
    ).toThrow(/required permission/);
    expect(() =>
      defineOperation({
        id: 'ok.read',
        name: 'x',
        description: 'x',
        requiredPermissions: ['p'],
        requiresConfirmation: undefined as never,
      }),
    ).toThrow(/requiresConfirmation/);
  });

  it('requires confirmation when the operation explicitly asks for it', () => {
    const operation = defineOperation({
      id: 'a.write',
      name: 'Write',
      description: 'Writes.',
      requiredPermissions: ['data.read'],
      requiresConfirmation: true,
    });
    expect(operationRequiresConfirmation(operation, [LOW])).toBe(true);
  });

  it('forces confirmation for high and critical risk even when the flag is false', () => {
    const declared = [LOW, HIGH, CRITICAL];
    for (const risky of [HIGH, CRITICAL]) {
      const operation = defineOperation({
        id: 'a.act',
        name: 'Act',
        description: 'Acts.',
        requiredPermissions: [risky.id],
        requiresConfirmation: false,
      });
      expect(operationRequiresConfirmation(operation, declared)).toBe(true);
    }
    const lowOperation = defineOperation({
      id: 'a.read',
      name: 'Read',
      description: 'Reads.',
      requiredPermissions: [LOW.id],
      requiresConfirmation: false,
    });
    expect(operationRequiresConfirmation(lowOperation, declared)).toBe(false);
  });

  it('cannot be lowered to no-confirmation once a required permission is high risk', () => {
    const operation = defineOperation({
      id: 'a.write',
      name: 'Write',
      description: 'Writes.',
      requiredPermissions: ['data.read', 'data.write'],
      requiresConfirmation: false,
    });
    expect(operationRequiresConfirmation(operation, [LOW, HIGH])).toBe(true);
  });
});
