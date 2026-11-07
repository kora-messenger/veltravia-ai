import { createHash } from 'node:crypto';

/** Content hash used everywhere in the integration layer (sha256, hex). */
export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function byteLength(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}

/** True when a hash looks like one this module produced. */
export function isContentHash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
