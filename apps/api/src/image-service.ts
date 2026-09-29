import {
  ImageIntelligenceManager,
  ImageProviderRegistry,
  type ImageAuditEvent,
} from '@veltravia/image-intelligence-core';
import { createMockImageProvider } from '@veltravia/image-intelligence-mock';
import type { FileIntelligenceManager } from '@veltravia/file-intelligence-core';

export interface ImageServiceOptions {
  readonly files: FileIntelligenceManager;
  readonly now?: () => Date;
  readonly onAudit?: (event: ImageAuditEvent) => void;
}

/**
 * Builds the API's Image Intelligence manager.
 *
 * DEVELOPMENT-ONLY PROVIDER NOTE (honest limitation, Step 21): the API
 * currently wires the deterministic MOCK provider. The mock simulates every
 * image capability offline and never represents real model quality. No real
 * vision provider is wired into the API in this step; wiring one (e.g. a
 * Gemini-backed image adapter) is a later roadmap item and must never be
 * faked here. IMAGE_MOCK_LATENCY_MS slows the simulated provider so
 * cancellation behavior can be exercised in live QA.
 */
export function createImageIntelligenceService(
  options: ImageServiceOptions,
): ImageIntelligenceManager {
  const raw = Number(process.env.IMAGE_MOCK_LATENCY_MS ?? '0');
  const latencyMs = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 5000) : 0;
  const registry = new ImageProviderRegistry();
  registry.register(createMockImageProvider({ latencyMs }));
  return new ImageIntelligenceManager({
    files: options.files,
    providers: registry,
    now: options.now,
    audit: options.onAudit ? { record: options.onAudit } : undefined,
  });
}
