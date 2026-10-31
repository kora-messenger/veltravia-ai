import {
  DocumentIntelligenceManager,
  DocumentProviderRegistry,
  type DocumentAuditEvent,
} from '@veltravia/document-intelligence-core';
import { createMockDocumentProvider } from '@veltravia/document-intelligence-mock';
import { createGatewayDocumentProvider, type AIProviderGateway } from '@veltravia/ai-gateway';
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

/**
 * Step 26: a document manager whose REASONING runs on the owner's own provider
 * through the AI gateway. Parsing is unchanged (it never used a model), the
 * trust model is unchanged (extracted text stays UNTRUSTED DATA), and the
 * provider is not a simulation, so job views report a real provider.
 *
 * This is a SEPARATE manager per owner on purpose: a job's artifacts, provider
 * identity and disclosures must never be mixed between two people's keys.
 */
export function createGatewayDocumentManager(options: {
  readonly files: FileIntelligenceManager;
  readonly gateway: AIProviderGateway;
  readonly ownerRef: string;
  readonly projectId?: string;
  readonly now?: () => Date;
  readonly onAudit?: (event: DocumentAuditEvent) => void;
}): DocumentIntelligenceManager {
  const registry = new DocumentProviderRegistry();
  registry.register(
    createGatewayDocumentProvider({
      gateway: options.gateway,
      scope: {
        ownerRef: options.ownerRef,
        ...(options.projectId ? { projectId: options.projectId } : {}),
      },
      ...(options.projectId ? { projectId: options.projectId } : {}),
    }) as unknown as Parameters<DocumentProviderRegistry['register']>[0],
  );
  return new DocumentIntelligenceManager({
    files: options.files,
    providers: registry,
    ...(options.now ? { now: options.now } : {}),
    ...(options.onAudit ? { audit: { record: options.onAudit } } : {}),
  });
}
