import { describe, expect, it } from 'vitest';

import { validIntegrationDefinition as validDefinition } from '../testing/index.js';
import {
  DuplicateIntegrationError,
  IntegrationInUseError,
  IntegrationNotFoundError,
  isIntegrationError,
} from '../errors/index.js';
import { IntegrationRegistry } from './index.js';

function registryWithDemo(): { registry: IntegrationRegistry } {
  const registry = new IntegrationRegistry();
  registry.register(validDefinition());
  return { registry };
}

describe('IntegrationRegistry', () => {
  it('registers, looks up, and lists deterministically', () => {
    const { registry } = registryWithDemo();
    expect(registry.has('demo-store')).toBe(true);
    expect(registry.get('demo-store').name).toBe('Demo Store');
    expect(registry.list()).toHaveLength(1);
    expect(registry.ids()).toEqual(['demo-store']);
  });

  it('rejects duplicate ids atomically', () => {
    const { registry } = registryWithDemo();
    expect(() => registry.register(validDefinition())).toThrow(DuplicateIntegrationError);
    expect(registry.list()).toHaveLength(1);
  });

  it('rejects invalid metadata without touching the catalog', () => {
    const { registry } = registryWithDemo();
    const bad = { ...validDefinition(), id: '' };
    expect(() => registry.register(bad)).toThrow();
    expect(registry.size).toBe(1);
  });

  it('rejects secret-bearing metadata', () => {
    const registry = new IntegrationRegistry();
    expect(() =>
      registry.register({
        ...validDefinition(),
        description: 'uses key sk-proj-ABCDEFGHIJKLMNOP1234',
      }),
    ).toThrow(/secret-shaped/);
    expect(registry.size).toBe(0);
  });

  it('is enabled by default and supports enable/disable', () => {
    const { registry } = registryWithDemo();
    expect(registry.isEnabled('demo-store')).toBe(true);
    registry.disable('demo-store');
    expect(registry.isEnabled('demo-store')).toBe(false);
    registry.enable('demo-store');
    expect(registry.isEnabled('demo-store')).toBe(true);
  });

  it('throws the typed not-found for unknown ids', () => {
    const { registry } = registryWithDemo();
    expect(() => registry.get('nope')).toThrow(IntegrationNotFoundError);
    expect(() => registry.disable('nope')).toThrow(IntegrationNotFoundError);
  });

  it('removes a registration when the guard allows it', () => {
    const { registry } = registryWithDemo();
    registry.remove('demo-store');
    expect(registry.has('demo-store')).toBe(false);
  });

  it('refuses removal while the integration is in use (guarded)', () => {
    const registry = new IntegrationRegistry({
      canRemove: (id) => id !== 'demo-store',
    });
    registry.register(validDefinition());
    expect(() => registry.remove('demo-store')).toThrow(IntegrationInUseError);
    expect(registry.has('demo-store')).toBe(true);
  });

  it('removal keeps other integrations untouched', () => {
    const { registry } = registryWithDemo();
    const other = { ...validDefinition(), id: 'demo-db', category: 'databases' as never };
    registry.register(other);
    registry.remove('demo-store');
    expect(registry.ids()).toEqual(['demo-db']);
  });
});

describe('isIntegrationError', () => {
  it('recognizes framework errors and rejects foreign ones', () => {
    expect(isIntegrationError(new IntegrationNotFoundError('x'))).toBe(true);
    expect(isIntegrationError(new Error('x'))).toBe(false);
    expect(isIntegrationError('x')).toBe(false);
  });
});
