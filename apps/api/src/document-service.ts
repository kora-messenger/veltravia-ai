import {
  DocumentIntelligenceManager,
  DocumentProviderRegistry,
  type DocumentAuditEvent,
} from '@veltravia/document-intelligence-core';
import { createMockDocumentProvider } from '@veltravia/document-intelligence-mock';
import type { FileIntelligenceManager } from '@veltravia/file-intelligence-core';

export interface DocumentServiceOptions {
  readonly files: FileIntelligenceManager;
  readonly now?: () => Date;
  readonly onAudit?: (event: DocumentAuditEvent) => void;
}

/**
 * Builds the API's Document Intelligence manager.
 *
 * DEVELOPMENT-ONLY PROVIDER NOTE (honest limitation, Step 23): the API wires
 * the deterministic MOCK provider. Parsing (DOCX/XLSX/PPTX/PDF/CSV/MD/HTML/
 * JSON/XML/TXT) is genuine; the reasoning side is a simulated provider that
 * quotes only text genuinely present in the parsed structure. It never
 * represents real model quality, and no real document-reasoning provider is
 * wired into the API in this step. DOCUMENT_MOCK_LATENCY_MS slows the
 * simulated provider so cancellation can be exercised in live QA.
 */
export function createDocumentIntelligenceService(
  options: DocumentServiceOptions,
): DocumentIntelligenceManager {
  const raw = Number(process.env.DOCUMENT_MOCK_LATENCY_MS ?? '0');
  const latencyMs = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 5000) : 0;
  const registry = new DocumentProviderRegistry();
  registry.register(createMockDocumentProvider({ latencyMs }));
  return new DocumentIntelligenceManager({
    files: options.files,
    providers: registry,
    now: options.now,
    audit: options.onAudit ? { record: options.onAudit } : undefined,
  });
}
