/** Provider registry: explicit registration, honest capability lookup.
 *  Registration grants nothing; the manager still re-checks every op. */
import { VideoIntelligenceError } from '../errors/index.js';
import type { VideoCapability, VideoProvider, VideoProviderCapabilities } from '../types/index.js';

const KNOWN_CAPABILITIES: readonly VideoCapability[] = [
  'video_understanding',
  'video_question_answering',
  'audio_understanding',
  'transcription',
  'timestamps',
  'scene_detection',
  'temporal_reasoning',
  'object_tracking',
  'ocr',
  'subtitle_extraction',
  'frame_analysis',
  'chart_understanding',
  'diagram_understanding',
  'screenshot_understanding',
  'structured_extraction',
  'summarization',
  'translation',
];

export function isVideoCapability(value: string): value is VideoCapability {
  return (KNOWN_CAPABILITIES as readonly string[]).includes(value);
}

function validateCapabilities(c: VideoProviderCapabilities): VideoProviderCapabilities {
  if (!c || typeof c !== 'object') throw new Error('Invalid capabilities');
  if (typeof c.providerId !== 'string' || !c.providerId)
    throw new Error('Capabilities must declare a providerId');
  if (
    !Array.isArray(c.capabilities) ||
    c.capabilities.some((v) => !isVideoCapability(v)) ||
    new Set(c.capabilities).size !== c.capabilities.length
  )
    throw new VideoIntelligenceError('VIDEO_INVALID_REQUEST');
  for (const n of [c.maxBytes, c.maxDurationSeconds, c.maxStreams])
    if (n !== null && (!Number.isFinite(n) || n <= 0))
      throw new VideoIntelligenceError('VIDEO_INVALID_REQUEST');
  if (
    c.supportedFormats !== null &&
    (!Array.isArray(c.supportedFormats) ||
      c.supportedFormats.some(
        (f) => !['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mpeg'].includes(f),
      ))
  )
    throw new VideoIntelligenceError('VIDEO_INVALID_REQUEST');
  return c;
}

export class VideoProviderRegistry {
  private readonly providers = new Map<string, VideoProvider>();

  register(provider: VideoProvider): void {
    if (!provider || typeof provider !== 'object')
      throw new VideoIntelligenceError('VIDEO_INVALID_REQUEST', 'Invalid video provider.');
    if (typeof provider.id !== 'string' || provider.id.length === 0)
      throw new VideoIntelligenceError('VIDEO_INVALID_REQUEST', 'Provider id is required.');
    if (typeof provider.analyze !== 'function' || typeof provider.getCapabilities !== 'function')
      throw new VideoIntelligenceError('VIDEO_INVALID_REQUEST', 'Provider contract is invalid.');
    const caps = validateCapabilities(provider.getCapabilities());
    if (caps.providerId !== provider.id || this.providers.has(provider.id))
      throw new VideoIntelligenceError('VIDEO_INVALID_REQUEST');
    this.providers.set(provider.id, provider);
  }

  get(id: string): VideoProvider | null {
    return this.providers.get(id) ?? null;
  }

  list(): readonly VideoProvider[] {
    return [...this.providers.values()];
  }

  /** First registered provider (registration order) that declares the capability. */
  findForCapability(capability: VideoCapability): VideoProvider | null {
    for (const p of this.providers.values()) {
      if (p.getCapabilities().capabilities.includes(capability)) return p;
    }
    return null;
  }
}
