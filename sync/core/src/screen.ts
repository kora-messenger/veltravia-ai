import { isCredentialFileName, scanForSecrets } from '@veltravia/export-core';

import type { SkippedFile } from './types.js';
import { SYNC_LIMITS } from './types.js';

/**
 * The same screening the ZIP export uses, applied in BOTH directions.
 *
 * Outbound: a credential file or a secret in the project is never written to
 * GitHub. Inbound: a credential file or a secret on the remote is never written
 * into the project. A file that fails is reported by path and reason only.
 */

export interface Screened {
  readonly ok: boolean;
  readonly skip?: SkippedFile;
}

export function screenFile(input: {
  readonly side: 'local' | 'remote';
  readonly path: string;
  readonly content: string;
}): Screened {
  const { side, path, content } = input;
  if (isCredentialFileName(path)) {
    return skip(side, path, 'credential-file', 'The file name marks it as holding credentials.');
  }
  if (Buffer.byteLength(content, 'utf8') > SYNC_LIMITS.maxFileBytes) {
    return skip(side, path, 'too-large', 'The file is larger than a synchronised file may be.');
  }
  const finding = scanForSecrets(content);
  if (finding !== null) {
    return skip(
      side,
      path,
      'secret-in-content',
      `The content looks like it contains a credential (${finding.kind}). It was left out.`,
    );
  }
  return { ok: true };
}

function skip(
  side: 'local' | 'remote',
  path: string,
  reason: SkippedFile['reason'],
  detail: string,
): Screened {
  return { ok: false, skip: { side, path, reason, detail } };
}
