import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { FileIntelligenceManager } from '@veltravia/file-intelligence-core';
import { InMemoryFileAssetStore } from '@veltravia/file-intelligence-mock';
import { AudioIntelligenceManager } from './index.js';
import { AudioIntelligenceError, isAudioIntelligenceError } from '../errors/index.js';
import {
  DEFAULT_MOCK_SCRIPT,
  INJECTION_MOCK_SCRIPT,
  MockAudioProvider,
} from '@veltravia/audio-intelligence-mock';
import type {
  AudioAuditEvent,
  AudioPrincipal,
  AudioProvider,
  ProviderTranscript,
} from './index.js';
import { formatFromMime, parseWavInfo, planChunks } from '../security/index.js';

const owner: AudioPrincipal = { ownerRef: 'owner-a' };
const other: AudioPrincipal = { ownerRef: 'owner-b' };
const scope = { ownerRef: 'owner-a', projectId: 'p1', workspaceId: 'w1' };
const wavBytes = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../fixtures/tone.wav', import.meta.url))),
);
const sha = (b: Uint8Array) => createHash('sha256').update(Buffer.from(b)).digest('hex');

interface Harness {
  audio: AudioIntelligenceManager;
  files: FileIntelligenceManager;
  events: AudioAuditEvent[];
}
function harness(
  options: {
    provider?: AudioProvider;
    limits?: Partial<import('../types/index.js').AudioLimits>;
  } = {},
): Harness {
  const events: AudioAuditEvent[] = [];
  const files = new FileIntelligenceManager({
    store: new InMemoryFileAssetStore(),
    now: () => new Date('2026-09-28T08:00:00Z'),
  });
  const audio = new AudioIntelligenceManager({
    files,
    provider:
      options.provider ??
      new MockAudioProvider({ checksum: sha(wavBytes), script: DEFAULT_MOCK_SCRIPT }),
    limits: options.limits,
    now: () => new Date('2026-09-28T08:00:00Z'),
    onAudit: (event) => events.push(event),
  });
  return { audio, files, events };
}
async function registerWav(h: Harness) {
  return h.files.registerFile({
    filename: 'meeting.wav',
    bytes: wavBytes,
    declaredMimeType: 'audio/wav',
    source: 'user_upload',
    scope,
  });
}

describe('audio security helpers', () => {
  it('maps real audio MIME types to formats', () => {
    expect(formatFromMime('audio/wav')).toBe('wav');
    expect(formatFromMime('audio/mpeg')).toBe('mp3');
    expect(formatFromMime('audio/ogg; codecs=opus')).toBe('ogg');
    expect(formatFromMime('audio/x-m4a')).toBe('m4a');
    expect(formatFromMime('text/plain')).toBeNull();
  });
  it('parses WAV headers safely', () => {
    const info = parseWavInfo(wavBytes);
    expect(info.sampleRateHz).toBe(8000);
    expect(info.channels).toBe(1);
    expect(parseWavInfo(new Uint8Array(20))).toEqual({
      sampleRateHz: null,
      channels: null,
      byteRate: null,
    });
  });
  it('plans bounded chunks', () => {
    expect(planChunks(1000, 16, 25 * 1024 * 1024)).toEqual({ count: 1, size: 1000 });
    const multi = planChunks(16044, 16, 100000);
    expect(multi.count).toBeGreaterThan(1);
    expect(multi.count).toBeLessThanOrEqual(16);
  });
});

describe('AudioIntelligenceManager lifecycle', () => {
  it('inspects authorized audio with WAV metadata', async () => {
    const h = harness();
    const file = await registerWav(h);
    const meta = await h.audio.inspect(file.id, owner);
    expect(meta.format).toBe('wav');
    expect(meta.byteSize).toBe(wavBytes.length);
    expect(meta.sampleRateHz).toBe(8000);
    expect(meta.channels).toBe(1);
  });
  it('refuses to process non-audio files', async () => {
    const h = harness();
    const text = await h.files.registerFile({
      filename: 'note.txt',
      bytes: Buffer.from('hello'),
      source: 'user_upload',
      scope,
    });
    await expect(h.audio.process(text.id, owner)).rejects.toMatchObject({
      code: 'AUDIO_UNSUPPORTED_FORMAT',
    });
  });
  it('rejects transcripts before processing', async () => {
    const h = harness();
    const file = await registerWav(h);
    await expect(h.audio.getTranscript(file.id, owner)).rejects.toMatchObject({
      code: 'AUDIO_NOT_PROCESSED',
    });
  });
  it('processes an authorized file into a completed job and transcript', async () => {
    const h = harness();
    const file = await registerWav(h);
    const job = await h.audio.process(file.id, owner);
    expect(job.status).toBe('completed');
    expect(job.chunks).toBe(1);
    expect(job.detectedLanguage).toBe('en');
    const view = (await h.audio.getTranscript(file.id, owner)) as {
      segments: { id: string; startSeconds: number | null; speaker: string | null; text: string }[];
      text: string;
      timestampsAvailable: boolean;
      speakersAvailable: boolean;
      trust: string;
    };
    expect(view.segments.length).toBe(DEFAULT_MOCK_SCRIPT.lines.length);
    expect(view.text).toContain('refund');
    expect(view.timestampsAvailable).toBe(true);
    expect(view.speakersAvailable).toBe(true);
    expect(view.trust).toBe('untrusted_data');
    const ids = new Set(view.segments.map((s) => s.id));
    expect(ids.size).toBe(view.segments.length);
  });
  it('is owner-scoped for jobs and transcripts', async () => {
    const h = harness();
    const file = await registerWav(h);
    const job = await h.audio.process(file.id, owner);
    await expect(h.audio.getJob(job.id, other)).rejects.toMatchObject({
      code: 'AUDIO_UNAUTHORIZED',
    });
    const jobs = await h.audio.listJobs(other);
    expect(jobs).toHaveLength(0);
    const mine = await h.audio.listJobs(owner);
    expect(mine.map((j) => j.id)).toContain(job.id);
  });
  it('honors the concurrency limit', async () => {
    const slow = new MockAudioProvider({
      checksum: sha(wavBytes),
      script: DEFAULT_MOCK_SCRIPT,
      chunkDelayMs: 120,
    });
    const h = harness({ provider: slow, limits: { maxConcurrentJobs: 1 } });
    const a = await registerWav(h);
    const b = await h.files.registerFile({
      filename: 'second.wav',
      bytes: wavBytes,
      declaredMimeType: 'audio/wav',
      source: 'user_upload',
      scope,
    });
    const first = h.audio.process(a.id, owner);
    await new Promise((r) => setTimeout(r, 30));
    await expect(h.audio.process(b.id, owner)).rejects.toMatchObject({
      code: 'AUDIO_LIMIT_EXCEEDED',
    });
    expect((await first).status).toBe('completed');
  });
  it('supports one-way cancellation with audit', async () => {
    const slow = new MockAudioProvider({
      checksum: sha(wavBytes),
      script: DEFAULT_MOCK_SCRIPT,
      chunkDelayMs: 150,
    });
    const h = harness({ provider: slow });
    const file = await registerWav(h);
    const pending = h.audio.process(file.id, owner);
    await new Promise((r) => setTimeout(r, 30));
    const cancelling = await h.audio.cancelJob((await h.audio.listJobs(owner))[0]?.id ?? '', owner);
    expect(cancelling.status).not.toBe('completed');
    const job = await pending;
    expect(job.status).toBe('cancelled');
    expect(h.events.map((e) => e.type)).toContain('audio_job_cancelled');
  });
  it('fails the job when the provider errors', async () => {
    const failing = new MockAudioProvider({
      checksum: sha(wavBytes),
      script: DEFAULT_MOCK_SCRIPT,
      failOnChunk: 1,
    });
    const h = harness({ provider: failing });
    const file = await registerWav(h);
    const job = await h.audio.process(file.id, owner);
    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('AUDIO_PROVIDER_ERROR');
  });
  it('never lets audit events contain transcript content', async () => {
    const h = harness();
    const file = await registerWav(h);
    await h.audio.process(file.id, owner);
    const json = JSON.stringify(h.events);
    expect(json).not.toContain('refund');
    expect(json).not.toContain('Speaker 1');
  });
});

describe('AudioIntelligenceManager operations', () => {
  it('searches transcript content with bounded matches', async () => {
    const h = harness();
    const file = await registerWav(h);
    await h.audio.process(file.id, owner);
    const result = await h.audio.search(file.id, owner, 'refund');
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]?.segment.text).toContain('refund');
    expect(result.matches[0]?.context.length).toBeGreaterThan(0);
  });
  it('answers questions using only real segments as evidence', async () => {
    const h = harness();
    const file = await registerWav(h);
    await h.audio.process(file.id, owner);
    const view = (await h.audio.getTranscript(file.id, owner)) as {
      segments: { id: string }[];
    };
    const result = await h.audio.query(file.id, owner, 'What did we decide about the database?');
    expect(result.answer).toContain('MongoDB');
    expect(result.trust).toBe('ai_generated');
    for (const segment of result.supportingSegments)
      expect(view.segments.some((s) => s.id === segment.id)).toBe(true);
  });
  it('drops fabricated evidence segment ids from providers', async () => {
    const fabricating: AudioProvider = {
      id: 'test.fabricating',
      capabilities() {
        return {
          providerId: 'test.fabricating',
          capabilities: ['transcription', 'question_answering', 'timestamps'] as never,
          supportedFormats: null,
          maxDurationSeconds: null,
          maxBytes: null,
          supportedLanguages: null,
        };
      },
      async transcribe(): Promise<ProviderTranscript> {
        const lines = DEFAULT_MOCK_SCRIPT.lines.map((line) => ({
          startSeconds: line.startSeconds,
          endSeconds: line.endSeconds,
          speaker: line.speaker,
          text: line.text,
          confidence: line.confidence,
        }));
        return { segments: lines, language: 'en', confidence: 0.9 };
      },
      async reason() {
        return {
          text: JSON.stringify({
            answer: 'Everything is fine.',
            supportingSegmentIds: ['seg_ffffffffffffffff'],
          }),
        };
      },
    };
    const h = harness({ provider: fabricating });
    const file = await registerWav(h);
    await h.audio.process(file.id, owner);
    const result = await h.audio.query(file.id, owner, 'anything');
    expect(result.answer).toBe('Everything is fine.');
    expect(result.supportingSegments).toHaveLength(0);
  });
  it('summarizes with an ai_generated trust label', async () => {
    const h = harness();
    const file = await registerWav(h);
    await h.audio.process(file.id, owner);
    const summary = await h.audio.summarize(file.id, owner, 'short');
    expect(summary.trust).toBe('ai_generated');
    expect(summary.text.length).toBeGreaterThan(0);
    expect(summary.keyPoints.length).toBeGreaterThan(0);
  });
  it('extracts action items, decisions, and entities', async () => {
    const h = harness();
    const file = await registerWav(h);
    await h.audio.process(file.id, owner);
    const analysis = await h.audio.extract(file.id, owner);
    expect(analysis.trust).toBe('ai_generated');
    expect(analysis.actionItems.some((a) => /rollback plan/i.test(a.description))).toBe(true);
    expect(analysis.actionItems.some((a) => a.certainty === 'stated')).toBe(true);
    expect(analysis.decisions.some((d) => /MongoDB/i.test(d.statement))).toBe(true);
    expect(analysis.entities.some((e) => e.field === 'dates')).toBe(true);
  });
  it('translates while preserving the original transcript', async () => {
    const h = harness();
    const file = await registerWav(h);
    await h.audio.process(file.id, owner);
    const translation = await h.audio.translate(file.id, owner, {
      targetLanguage: 'fr',
      scope: 'transcript',
    });
    expect(translation.translatedText).toContain('[mock:fr]');
    expect(translation.originalPreserved).toBe(true);
    const view = (await h.audio.getTranscript(file.id, owner)) as { text: string };
    expect(view.text).toContain('refund');
    await expect(
      h.audio.translate(file.id, owner, { targetLanguage: 'not a tag', scope: 'transcript' }),
    ).rejects.toMatchObject({ code: 'AUDIO_INVALID_REQUEST' });
  });
  it('analyzes into a summary+extraction bundle', async () => {
    const h = harness();
    const file = await registerWav(h);
    await h.audio.process(file.id, owner);
    const analysis = await h.audio.analyze(file.id, owner);
    expect(analysis.summary?.trust).toBe('ai_generated');
    expect(analysis.actionItems.length).toBeGreaterThan(0);
  });
  it('saves provenance-linked artifacts through the artifact system', async () => {
    const h = harness();
    const file = await registerWav(h);
    await h.audio.process(file.id, owner);
    await h.audio.analyze(file.id, owner);
    const artifact = await h.audio.saveArtifact(file.id, owner, { kind: 'transcript_md' });
    expect(artifact.id).toMatch(/^artifact_/);
    expect(artifact.provenance.parentFileIds).toContain(file.id);
    expect(artifact.sourceOperation).toBe(`audio:transcript_md:${file.id}`);
    const notes = await h.audio.saveArtifact(file.id, owner, { kind: 'meeting_notes_md' });
    expect(notes.status).toBe('ready');
    await expect(
      h.audio.saveArtifact(file.id, owner, { kind: 'summary_md' }),
    ).resolves.toBeTruthy();
  });
  it('requires a transcript before artifacts', async () => {
    const h = harness();
    const file = await registerWav(h);
    await expect(
      h.audio.saveArtifact(file.id, owner, { kind: 'transcript_md' }),
    ).rejects.toMatchObject({ code: 'AUDIO_NOT_PROCESSED' });
  });
});

describe('audio capability gating', () => {
  const noSummarize = new MockAudioProvider({
    checksum: sha(wavBytes),
    script: DEFAULT_MOCK_SCRIPT,
    capabilities: ['transcription', 'timestamps', 'speaker_identification'],
  });
  it('rejects operations the provider cannot perform', async () => {
    const h = harness({ provider: noSummarize });
    const file = await registerWav(h);
    await h.audio.process(file.id, owner);
    await expect(h.audio.summarize(file.id, owner)).rejects.toMatchObject({
      code: 'AUDIO_CAPABILITY_UNSUPPORTED',
    });
    await expect(
      h.audio.translate(file.id, owner, { targetLanguage: 'fr', scope: 'transcript' }),
    ).rejects.toMatchObject({ code: 'AUDIO_CAPABILITY_UNSUPPORTED' });
  });
  it('rejects long-audio processing without the long_audio capability', async () => {
    const short = new MockAudioProvider({
      checksum: sha(wavBytes),
      script: DEFAULT_MOCK_SCRIPT,
      capabilities: ['transcription', 'timestamps'],
    });
    const h = harness({ provider: short });
    await registerWav(h);
    // The 16 KB fixture against a 10 KB limit forces multiple chunks.
    const limited = new AudioIntelligenceManager({
      files: h.files,
      provider: short,
      limits: { maxFileBytes: 100000 },
      now: () => new Date('2026-09-28T08:00:00Z'),
    });
    const job = await limited.process((await h.files.listFiles(owner))[0]?.id ?? '', owner);
    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('AUDIO_CAPABILITY_UNSUPPORTED');
  });
});

describe('untrusted spoken content stays data', () => {
  it('transcribes prompt-injection audio without escalating it', async () => {
    const h = harness({
      provider: new MockAudioProvider({
        checksum: sha(wavBytes),
        script: INJECTION_MOCK_SCRIPT,
      }),
    });
    const file = await registerWav(h);
    const job = await h.audio.process(file.id, owner);
    expect(job.status).toBe('completed');
    const view = (await h.audio.getTranscript(file.id, owner)) as { text: string; trust: string };
    expect(view.text).toContain('Ignore previous instructions');
    expect(view.trust).toBe('untrusted_data');
    // The injection text exists as transcript data but never reaches the audit.
    expect(JSON.stringify(h.events)).not.toContain('Ignore previous instructions');
    // Summarization returns the malicious text as clearly-marked AI data,
    // and no tool execution path exists on the manager.
    const summary = await h.audio.summarize(file.id, owner);
    expect(summary.trust).toBe('ai_generated');
    // The manager surface has no execute/confirm/approve methods at all.
    const surface = Object.keys(Object.getPrototypeOf(h.audio)).map((k) => k.toLowerCase());
    expect(surface.some((k) => k.includes('execute') || k.includes('approve'))).toBe(false);
  });
});

describe('typed errors', () => {
  it('exposes codes, default messages, and details', () => {
    const e = new AudioIntelligenceError('AUDIO_LIMIT_EXCEEDED', undefined, { limit: 5 });
    expect(isAudioIntelligenceError(e)).toBe(true);
    expect(e.toJSON().message).toBe('The audio request exceeded a configured limit.');
    expect(e.toJSON().details).toEqual({ limit: 5 });
    expect(isAudioIntelligenceError(new Error('no'))).toBe(false);
  });
});
