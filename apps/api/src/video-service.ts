import {
  VideoIntelligenceManager,
  VideoProviderRegistry,
} from '@veltravia/video-intelligence-core';
import { createMockVideoProvider } from '@veltravia/video-intelligence-mock';
import type { FileIntelligenceManager } from '@veltravia/file-intelligence-core';
/** Development-only deterministic simulation. No real video model is wired. */
export function createVideoIntelligenceService(options: {
  files: FileIntelligenceManager;
  now?: () => Date;
}): VideoIntelligenceManager {
  const providers = new VideoProviderRegistry();
  const raw = Number(process.env.VIDEO_MOCK_LATENCY_MS ?? '0');
  providers.register(
    createMockVideoProvider({
      latencyMs: Number.isFinite(raw) ? Math.min(5000, Math.max(0, raw)) : 0,
    }),
  );
  return new VideoIntelligenceManager({ files: options.files, providers, now: options.now });
}
