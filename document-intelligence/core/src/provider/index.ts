/** Provider registry: explicit registration, honest capability lookup.
 *  Registration grants nothing; the manager still re-checks every op. */
import { DocumentIntelligenceError } from '../errors/index.js';
import {
  DOCUMENT_CAPABILITIES,
  DOCUMENT_PROVIDER_OPERATIONS,
  type DocumentCapability,
  type DocumentProviderOperation,
  type DocumentStructureView,
} from '../types/index.js';

export interface DocumentProviderCapabilities {
  readonly providerId: string;
  readonly capabilities: readonly DocumentCapability[];
  readonly simulated: boolean;
}

export interface DocumentProviderRequest {
  readonly operation: DocumentProviderOperation;
  /** Parsed structure of the subject document. UNTRUSTED DATA. */
  readonly structure: DocumentStructureView;
  /** Second document for comparisons. UNTRUSTED DATA. */
  readonly compareStructure?: DocumentStructureView;
  /** Operation input (question, query, mode). UNTRUSTED DATA. */
  readonly input: Readonly<Record<string, unknown>>;
}

export interface DocumentProvider {
  readonly id: string;
  getCapabilities(): DocumentProviderCapabilities;
  /** Returns raw JSON text; the reasoning layer parses and validates it. */
  process(request: DocumentProviderRequest): Promise<string>;
}

export function isDocumentCapability(value: string): value is DocumentCapability {
  return (DOCUMENT_CAPABILITIES as readonly string[]).includes(value);
}

function validateCapabilities(c: DocumentProviderCapabilities): DocumentProviderCapabilities {
  if (!c || typeof c !== 'object') throw new Error('Invalid capabilities');
  if (typeof c.providerId !== 'string' || !c.providerId)
    throw new Error('Capabilities must declare a providerId');
  if (!Array.isArray(c.capabilities)) throw new Error('Capabilities must be an array');
  for (const cap of c.capabilities) {
    if (typeof cap !== 'string' || !isDocumentCapability(cap))
      throw new Error(`Unknown document capability: ${String(cap)}`);
  }
  return c;
}

export function isDocumentProviderOperation(value: string): value is DocumentProviderOperation {
  return (DOCUMENT_PROVIDER_OPERATIONS as readonly string[]).includes(value);
}

export class DocumentProviderRegistry {
  private readonly providers = new Map<string, DocumentProvider>();

  register(provider: DocumentProvider): void {
    if (!provider || typeof provider !== 'object')
      throw new DocumentIntelligenceError('DOCUMENT_INVALID_REQUEST', 'Invalid document provider.');
    if (typeof provider.id !== 'string' || provider.id.length === 0)
      throw new DocumentIntelligenceError('DOCUMENT_INVALID_REQUEST', 'Provider id is required.');
    if (typeof provider.process !== 'function' || typeof provider.getCapabilities !== 'function')
      throw new DocumentIntelligenceError(
        'DOCUMENT_INVALID_REQUEST',
        'Provider contract is invalid.',
      );
    validateCapabilities(provider.getCapabilities());
    this.providers.set(provider.id, provider);
  }

  get(id: string): DocumentProvider | null {
    return this.providers.get(id) ?? null;
  }

  list(): readonly DocumentProvider[] {
    return [...this.providers.values()];
  }

  /** First registered provider (registration order) that declares the capability. */
  findForCapability(capability: DocumentCapability): DocumentProvider | null {
    for (const p of this.providers.values()) {
      if (p.getCapabilities().capabilities.includes(capability)) return p;
    }
    return null;
  }
}
