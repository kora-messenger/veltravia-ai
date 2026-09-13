import type { ConnectorCapability } from './capabilities.js';
import type { ConnectorCategory } from './category.js';

/**
 * Strongly typed, provider-neutral connector metadata.
 *
 * This is the "identity card" of a connector - pure metadata, no behavior,
 * no vendor assumptions, and no secret material of any kind.
 */
export interface ConnectorMetadata {
  /** Unique, stable, machine-friendly id (kebab-case, e.g. "object-storage"). */
  readonly id: string;
  /** Human display name (e.g. "Object Storage"). */
  readonly name: string;
  /** Connector version (semver: "1.0.0"). */
  readonly version: string;
  /** What this connector integrates with, in one or two sentences. */
  readonly description: string;
  /** Provider-neutral category (source_control, database, ...). */
  readonly category: ConnectorCategory;
  /** Generic capabilities this connector DECLARES - never auto-granted. */
  readonly capabilities: readonly ConnectorCapability[];
}
