import { createIntegrationAuditEvent, type IntegrationAuditSink } from '../audit/index.js';
import {
  DuplicateIntegrationError,
  IntegrationInUseError,
  IntegrationNotFoundError,
} from '../errors/index.js';
import { defineIntegration, type IntegrationDefinition } from '../types/integration.js';

/**
 * The integration registry: an ordered, in-memory catalog of VALIDATED
 * integration definitions - evolving the Step 4 connector registry
 * pattern rather than replacing it.
 *
 * - registration validates the definition (duplicates, malformed metadata,
 *   secret-bearing metadata, and undeclared scope references are rejected)
 * - lookup is by unique id; listing preserves registration order
 * - enable/disable is an operator-owned kill switch: a disabled integration
 *   refuses connections and operations
 * - removal is guarded: an integration with live connections cannot be
 *   removed (the guard is injected by the system facade)
 */
export interface IntegrationRegistryOptions {
  /** Guard consulted before removal: false = integration still in use. */
  readonly canRemove?: (integrationId: string) => boolean;
  /** Receives lifecycle audit events. */
  readonly onAudit?: IntegrationAuditSink;
}

interface RegisteredIntegration {
  readonly definition: IntegrationDefinition;
  enabled: boolean;
}

export class IntegrationRegistry {
  private readonly integrations = new Map<string, RegisteredIntegration>();
  private readonly canRemove?: (integrationId: string) => boolean;
  private readonly onAudit?: IntegrationAuditSink;

  constructor(options: IntegrationRegistryOptions = {}) {
    this.canRemove = options.canRemove;
    this.onAudit = options.onAudit;
  }

  /**
   * Registers a validated integration definition. Duplicate ids and
   * invalid metadata are rejected atomically - the registry is untouched.
   */
  register(input: IntegrationDefinition): IntegrationDefinition {
    const definition = defineIntegration(input);
    if (this.integrations.has(definition.id)) {
      throw new DuplicateIntegrationError(definition.id);
    }
    this.integrations.set(definition.id, { definition, enabled: true });
    this.audit('integration_registered', definition.id, `Registered "${definition.name}"`);
    return definition;
  }

  /** Whether an integration id is registered. */
  has(id: string): boolean {
    return this.integrations.has(id);
  }

  /** The registered definition. Throws when unknown. */
  get(id: string): IntegrationDefinition {
    const entry = this.integrations.get(id);
    if (entry === undefined) throw new IntegrationNotFoundError(id);
    return entry.definition;
  }

  /** All definitions in registration order. */
  list(): readonly IntegrationDefinition[] {
    return [...this.integrations.values()].map((entry) => entry.definition);
  }

  /** Registered ids in registration order. */
  ids(): readonly string[] {
    return [...this.integrations.keys()];
  }

  /** Number of registered integrations. */
  get size(): number {
    return this.integrations.size;
  }

  /** Whether an integration is enabled (registered = enabled by default). */
  isEnabled(id: string): boolean {
    const entry = this.integrations.get(id);
    if (entry === undefined) throw new IntegrationNotFoundError(id);
    return entry.enabled;
  }

  /** Operator kill switch: disabled integrations fail closed everywhere. */
  enable(id: string): void {
    const entry = this.require(id);
    if (!entry.enabled) {
      entry.enabled = true;
      this.audit('integration.enabled', id, 'Integration enabled');
    }
  }

  disable(id: string): void {
    const entry = this.require(id);
    if (entry.enabled) {
      entry.enabled = false;
      this.audit('integration.disabled', id, 'Integration disabled');
    }
  }

  /**
   * Removes a registration - only when nothing depends on it. Throws the
   * typed not-found when unknown; when the injected guard says the
   * integration is still in use, removal is refused.
   */
  remove(id: string): void {
    this.require(id);
    if (this.canRemove?.(id) === false) {
      throw new IntegrationInUseError(id, 1);
    }
    this.integrations.delete(id);
    this.audit('integration_removed', id, 'Integration removed from the catalog');
  }

  private require(id: string): RegisteredIntegration {
    const entry = this.integrations.get(id);
    if (entry === undefined) throw new IntegrationNotFoundError(id);
    return entry;
  }

  private audit(
    type:
      | 'integration_registered'
      | 'integration_removed'
      | 'integration.enabled'
      | 'integration.disabled',
    id: string,
    summary: string,
  ): void {
    this.onAudit?.(createIntegrationAuditEvent({ type, integrationId: id, summary }));
  }
}
