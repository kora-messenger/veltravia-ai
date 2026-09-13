import { describe, expect, it } from 'vitest';
import {
  definePermission,
  isPermissionRiskLevel,
  PermissionSet,
  PERMISSION_RISK_LEVELS,
} from './index.js';

describe('permissions', () => {
  it('defines a valid permission with id, description, and risk level', () => {
    const permission = definePermission('repositories.read', 'Read repositories.', 'low');
    expect(permission).toEqual({
      id: 'repositories.read',
      description: 'Read repositories.',
      riskLevel: 'low',
    });
  });

  it('rejects invalid permission ids, descriptions, and risk levels', () => {
    expect(() => definePermission('', 'desc', 'low')).toThrow();
    expect(() => definePermission('UPPER CASE', 'desc', 'low')).toThrow();
    expect(() => definePermission('ok.id', '', 'low')).toThrow();
    expect(() => definePermission('ok.id', 'desc', 'extreme' as never)).toThrow();
  });

  it('recognizes the four documented risk levels', () => {
    expect(PERMISSION_RISK_LEVELS).toEqual(['low', 'medium', 'high', 'critical']);
    expect(isPermissionRiskLevel('critical')).toBe(true);
    expect(isPermissionRiskLevel('ultra')).toBe(false);
  });

  it('PermissionSet starts empty and never auto-includes anything', () => {
    const set = PermissionSet.empty();
    expect(set.size).toBe(0);
    expect(set.has('anything')).toBe(false);
    expect(set.hasAll(['a', 'b'])).toBe(false);
  });

  it('PermissionSet is immutable: with/without derive new sets', () => {
    const base = PermissionSet.empty();
    const granted = base.with('a.read', 'a.write');
    expect(base.size).toBe(0);
    expect(granted.hasAll(['a.read', 'a.write'])).toBe(true);
    const narrowed = granted.without('a.write');
    expect(narrowed.has('a.read')).toBe(true);
    expect(narrowed.has('a.write')).toBe(false);
    expect(granted.has('a.write')).toBe(true);
    expect(granted.list()).toEqual(['a.read', 'a.write']);
  });
});
