import { createHash } from 'node:crypto';

/**
 * The content identity used to compare the project with the remote.
 *
 * It is Git's own blob hash: sha1 over `blob <byteLength>\0<content>`. Both
 * sides of a comparison use it, which is what makes them comparable at all:
 *
 * - GitHub reports a blob sha for every file in a tree, so a plan can be built
 *   from ONE tree read without downloading a repository;
 * - the project side computes the same value from the file's text.
 *
 * A plain sha256 of the text would be a fine identity too, but it could never
 * be compared with GitHub's, so every unchanged file would look modified. The
 * value is an identity, never a security control: nothing is authenticated by
 * it, and a collision carries no privilege.
 */
export function contentSha(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha1')
    .update(`blob ${String(bytes.length)}\u0000`)
    .update(bytes)
    .digest('hex');
}
