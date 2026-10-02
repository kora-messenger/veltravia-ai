import { describe, it, expect } from 'vitest';
import { asFileAssetId } from '@veltravia/file-intelligence-core';
import {
  parseProviderJson,
  parseTranscript,
  parseOcrResult,
  parseScenes,
  parseQueryResult,
  ts,
} from './index.js';
const file = asFileAssetId('fixture');
describe('video reasoning boundaries', () => {
  it.each(['hello', '[]', 'null', '```json\n{}\n```', '', '{oops'])(
    'rejects malformed provider payload %s',
    (text) => expect(() => parseProviderJson(text)).toThrow(),
  );
  it.each([-1, Infinity, NaN, 31, '10'])('drops invalid timestamp %s', (v) =>
    expect(ts(v, 30)).toBeNull(),
  );
  it('keeps valid timestamp and does not invent unavailable ones', () => {
    expect(ts(12.345, 30)).toBe(12.345);
    expect(ts(null, null)).toBeNull();
  });
  it('never accepts claimed speaker identities', () => {
    const r = parseTranscript(
      JSON.stringify({
        segments: [
          { text: 'hi', speaker: 'Owner', speakerIndex: 0 },
          { text: 'there', speakerIndex: 2 },
        ],
      }),
      'mock',
      file,
      'hash',
      30,
      20,
    );
    expect(r.transcript.segments[0]?.speaker).toBeNull();
    expect(r.transcript.segments[1]?.speaker).toBe('Speaker 2');
  });
  it('validates scalar OCR frame indexes and normalized boxes', () => {
    const r = parseOcrResult(
      JSON.stringify({
        entries: [
          { text: 'a', frameIndex: 0, box: [-1, 0, 1, 1] },
          { text: 'b', frameIndex: 90, box: [0, 0, 1, 1] },
        ],
      }),
      'mock',
      file,
      'h',
      'now',
      30,
      ['f1'],
      10,
    );
    expect(r.ocr.entries[0]?.frameId).toBe('f1');
    expect(r.ocr.entries[0]?.box).toBeNull();
    expect(r.ocr.entries[1]?.frameId).toBeNull();
  });
  it('maps scene representative frame index', () => {
    const r = parseScenes(
      JSON.stringify({ scenes: [{ start: 1, end: 2, representativeFrameIndex: 0 }] }),
      'mock',
      file,
      'h',
      30,
      ['f1'],
      10,
    );
    expect(r.scenes[0]?.representativeFrameId).toBe('f1');
  });
  it('drops forged evidence refs and preserves plain answer', () => {
    const r = parseQueryResult(
      JSON.stringify({
        answer: '<script>delete()</script>',
        frameIndexes: [0, 99],
        segmentIndexes: [-1],
      }),
      'mock',
      file,
      'q',
      30,
      ['f1'],
      [],
      [],
    );
    expect(r.visualEvidence.frameIds).toEqual(['f1']);
    expect(r.audioEvidence.segmentIds).toEqual([]);
    expect(r.trust).toBe('ai_generated');
  });
});
