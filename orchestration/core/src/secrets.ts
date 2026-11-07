/**
 * Secret-shaped text detection, shared by every orchestration surface.
 *
 * `containsSecretShapedContent` anchors most of its patterns to a whole value,
 * so it fires on a key on its own but not on a sentence that contains one. Task
 * and worker text has no quoting contract, so each whitespace-delimited token is
 * scanned as well. Bounded, and only presence is ever recorded.
 */

import { containsSecretShapedContent } from '@veltravia/project-core';

export function containsSecretShaped(text: string): boolean {
  try {
    if (containsSecretShapedContent(text)) return true;
    const tokens = text.split(/[\s"'`,;:(){}<>[\]]+/).slice(0, 400);
    return tokens.some((token) => {
      const trimmed = token.replace(/[.!?]+$/, '');
      return trimmed.length >= 12 && containsSecretShapedContent(trimmed);
    });
  } catch {
    return false;
  }
}
