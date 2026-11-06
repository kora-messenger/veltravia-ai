import { EXPORT_LIMITS } from './types.js';
import { ExportError } from './errors.js';

/**
 * Path policy. A path is relative to the project root, uses `/`, and stays
 * inside it. Rejection messages never echo the offending path back verbatim
 * beyond what the caller already sent, and never include file content.
 */

/** Characters that have no business in a project path. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f\\]/;

export function assertSafeExportPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ExportError('EXPORT_PATH_INVALID', 'A path must be a non-empty string.');
  }
  if (raw.length > EXPORT_LIMITS.maxPathLength) {
    throw new ExportError('EXPORT_PATH_INVALID', 'A path is too long.');
  }
  if (FORBIDDEN_CHARS.test(raw)) {
    throw new ExportError('EXPORT_PATH_INVALID', 'A path contains a forbidden character.');
  }
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) {
    throw new ExportError('EXPORT_PATH_INVALID', 'A path must be relative to the project.');
  }
  // Percent-encoded traversal is refused rather than decoded: a path here is a
  // literal name, so "%2e%2e" is not a way to say "..".
  if (/%2e|%2f|%5c/i.test(raw)) {
    throw new ExportError('EXPORT_PATH_INVALID', 'A path contains an encoded separator.');
  }
  const segments = raw.split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new ExportError('EXPORT_PATH_INVALID', 'A path has an empty segment.');
    }
    if (segment === '.' || segment === '..') {
      throw new ExportError('EXPORT_PATH_INVALID', 'A path steps outside the project.');
    }
    if (segment.length > 255) {
      throw new ExportError('EXPORT_PATH_INVALID', 'A path segment is too long.');
    }
  }
  return raw;
}

/** True when `path` is `selected` itself or lies inside the directory `selected`. */
export function isWithin(path: string, selected: string): boolean {
  return path === selected || path.startsWith(`${selected}/`);
}

/**
 * Names that hold credentials by convention. Matching is on the final path
 * segment, case-insensitively. This list is about FILE NAMES; content is
 * scanned separately.
 */
const CREDENTIAL_NAMES = new Set([
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  '.htpasswd',
  '.pgpass',
  '.dockercfg',
  'credentials',
  'credentials.json',
  'service-account.json',
  'serviceaccount.json',
  'secrets.json',
  'secrets.yml',
  'secrets.yaml',
  'secret.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'terraform.tfvars',
  'google-services.json.bak',
]);

const CREDENTIAL_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.ppk', '.asc'];

/**
 * Environment files: `.env`, `.env.local`, `.env.production`, `prod.env`,
 * `.envrc`. Template files that only document variable names are kept.
 */
const ENV_TEMPLATE_SUFFIX = /\.(example|sample|template|dist|defaults?)$/i;

export function isCredentialFileName(path: string): boolean {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  if (CREDENTIAL_NAMES.has(name)) return true;
  if (CREDENTIAL_EXTENSIONS.some((extension) => name.endsWith(extension))) return true;
  if (name === '.envrc') return true;
  const isEnvFile = name === '.env' || name.startsWith('.env.') || name.endsWith('.env');
  if (isEnvFile && !ENV_TEMPLATE_SUFFIX.test(name)) return true;
  return false;
}

/** Normalise a selection: validate, drop duplicates and paths covered by a parent. */
export function normaliseSelection(paths: readonly unknown[]): string[] {
  if (paths.length === 0) {
    throw new ExportError('EXPORT_SELECTION_EMPTY', 'Select at least one file or folder.');
  }
  if (paths.length > EXPORT_LIMITS.maxSelectionPaths) {
    throw new ExportError('EXPORT_INVALID_REQUEST', 'That selection names too many paths.');
  }
  const unique = [...new Set(paths.map((raw) => assertSafeExportPath(raw)))].sort();
  return unique.filter(
    (path, index) =>
      !unique.some((other, otherIndex) => otherIndex !== index && isWithin(path, other)),
  );
}
