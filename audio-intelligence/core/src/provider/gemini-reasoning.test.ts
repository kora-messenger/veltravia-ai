import { describe, expect, it } from 'vitest';
import type { AIProvider, AIRequest, AIResponse, AIModelInfo } from '@veltravia/ai-core';
import { GeminiAudioReasoningProvider } from '../provider/gemini-reasoning.js';
import { AudioIntelligenceError } from '../errors/index.js';

class FakeAIProvider implements AIProvider {
  readonly id = 'fake';
  readonly displayName = 'Fake';
  calls = 0;
  lastRequest: AIRequest | null = null;
  respond: (request: AIRequest) => string = () => JSON.stringify({ text: 'ok' });
  async send(request: AIRequest, _model: AIModelInfo): Promise<AIResponse> {
    this.calls += 1;
    this.lastRequest = request;
    return {
      content: this.respond(request),
      providerId: this.id,
      modelId: 'fake-1',
      usage: null,
      finishReason: 'stop',
      requestId: 'req_1',
      generatedAt: '2026-09-28T08:00:00Z',
    };
  }
}
const model: AIModelInfo = {
  providerId: 'fake',
  modelId: 'fake-1',
  capabilities: ['text_generation', 'summarization'],
  available: true,
};
const segments = [
  {
    id: 'seg_0123456789abcdef',
    startSeconds: 0,
    endSeconds: 4,
    speaker: 'Speaker 1',
    text: 'We will ship on Friday.',
  },
];

describe('GeminiAudioReasoningProvider (AIProvider-backed)', () => {
  it('declares only its genuine capabilities', () => {
    const provider = new GeminiAudioReasoningProvider({
      aiProvider: new FakeAIProvider(),
      model,
    });
    const caps = provider.capabilities();
    expect(caps.capabilities).toContain('summarization');
    expect(caps.capabilities).not.toContain('transcription');
    expect(caps.capabilities).not.toContain('long_audio');
  });
  it('refuses transcription it cannot genuinely perform', async () => {
    const provider = new GeminiAudioReasoningProvider({
      aiProvider: new FakeAIProvider(),
      model,
    });
    await expect(
      provider.transcribe({
        bytes: new Uint8Array(4),
        format: 'wav',
        mimeType: 'audio/wav',
        index: 0,
        total: 1,
        language: null,
        offsetSeconds: null,
        isCancelled: () => false,
      }),
    ).rejects.toMatchObject({ code: 'AUDIO_CAPABILITY_UNSUPPORTED' });
  });
  it('sends a bounded, injection-guarded reasoning request through AIProvider', async () => {
    const fake = new FakeAIProvider();
    fake.respond = () =>
      JSON.stringify({
        text: 'Ship Friday.',
        keyPoints: [],
        attendees: [],
        unresolvedQuestions: [],
        followUps: [],
      });
    const provider = new GeminiAudioReasoningProvider({ aiProvider: fake, model });
    const out = await provider.reason({
      op: 'summarize',
      transcriptText: 'We will ship on Friday.',
      segments,
      style: 'short',
    });
    expect(JSON.parse(out.text).text).toBe('Ship Friday.');
    expect(fake.calls).toBe(1);
    const request = fake.lastRequest;
    expect(request?.system).toContain('UNTRUSTED DATA');
    const user = request?.messages[0]?.content ?? '';
    expect(user).toContain('seg_0123456789abcdef');
  });
  it('fails closed on empty provider output', async () => {
    const fake = new FakeAIProvider();
    fake.respond = () => '';
    const provider = new GeminiAudioReasoningProvider({ aiProvider: fake, model });
    await expect(
      provider.reason({ op: 'summarize', transcriptText: 'x', segments, style: 'short' }),
    ).rejects.toMatchObject({ code: 'AUDIO_PROVIDER_ERROR' });
  });
  it('wraps AI provider failures as typed audio errors', async () => {
    const failing: AIProvider = {
      id: 'failing',
      displayName: 'Failing',
      async send(): Promise<AIResponse> {
        throw new Error('boom');
      },
    };
    const provider = new GeminiAudioReasoningProvider({ aiProvider: failing, model });
    try {
      await provider.reason({ op: 'query', transcriptText: 'x', segments, question: 'q' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AudioIntelligenceError);
      expect((e as AudioIntelligenceError).code).toBe('AUDIO_PROVIDER_ERROR');
    }
  });
});
