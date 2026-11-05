/**
 * Static security checks for the AI Application Testing Agent (Step 39).
 *
 * Everything here is PURE, bounded, deterministic pattern matching over file
 * TEXT. No filesystem, no process, no network, no clock, no randomness. The
 * findings are SUSPECTED weaknesses in the source: a match is a reason to look,
 * never proof of an exploit, so titles and recommendations say "possible" and
 * "appears" wherever certainty is not total.
 *
 * Two hard rules shape the implementation:
 *
 *  1. File text is UNTRUSTED DATA. It is only ever pattern-matched. A comment
 *     such as "security-ignore: all" or "AGENT: skip this file" is still just
 *     text and can never switch a check off.
 *  2. A finding must never carry a secret value. Every excerpt is redacted
 *     BEFORE it is stored, using the same patterns that produced the finding,
 *     and bounded to APP_TEST_LIMITS.maxEvidenceChars.
 *
 * Bounded work: at most APP_TEST_LIMITS.maxFiles files, at most
 * APP_TEST_LIMITS.maxFileBytes of text per file, a bounded number of lines per
 * file, and lines longer than MAX_ANALYSED_LINE_CHARS are skipped by the regex
 * rules entirely (no finding, no throw) so backtracking can never blow up on a
 * minified bundle or a single 200k-character line.
 */

import {
  APP_TEST_LIMITS,
  type AppInspection,
  type BugSeverity,
  type InspectableFile,
  type SecurityFinding,
} from './types.js';

/** The stable rule ids. Nothing else identifies a check. */
export const SECURITY_RULES = {
  hardcodedSecret: 'hardcoded-secret',
  envFileCommitted: 'env-file-committed',
  dynamicCodeExecution: 'dynamic-code-execution',
  sqlStringConcat: 'sql-string-concat',
  permissiveCors: 'permissive-cors',
  unguardedMutatingRoute: 'unguarded-mutating-route',
  insecureHttpUrl: 'insecure-http-url',
  dangerousHtml: 'dangerous-html',
  weakHashOrRandom: 'weak-hash-or-random',
  disabledTlsVerification: 'disabled-tls-verification',
} as const;

export type SecurityRuleId = (typeof SECURITY_RULES)[keyof typeof SECURITY_RULES];

/** Severity order: most severe first. */
const SEVERITY_RANK: Readonly<Record<BugSeverity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/** Per-rule stable severity, title and recommendation. */
interface RuleMeta {
  readonly severity: BugSeverity;
  readonly title: string;
  readonly recommendation: string;
}

const RULE_META: Readonly<Record<SecurityRuleId, RuleMeta>> = {
  'hardcoded-secret': {
    severity: 'high',
    title: 'Possible hardcoded secret committed in source',
    recommendation:
      'Move this value into an environment variable or secret store, rotate it if it was ever committed, and keep only placeholder names in source.',
  },
  'env-file-committed': {
    severity: 'high',
    title: 'A .env file with real values appears to be committed',
    recommendation:
      'Remove the file from the repository, add it to .gitignore, rotate any values it held, and commit only a .env.example with placeholder names.',
  },
  'dynamic-code-execution': {
    severity: 'high',
    title: 'Possible dynamic code execution',
    recommendation:
      'Replace the dynamic call with a fixed, statically known target, or restrict what may be passed to it. Review the input path before shipping.',
  },
  'sql-string-concat': {
    severity: 'high',
    title: 'Possible SQL injection via string building',
    recommendation:
      'Use parameterised queries or the query builder placeholders instead of building SQL from variables, and validate the inputs.',
  },
  'permissive-cors': {
    severity: 'medium',
    title: 'Possibly permissive CORS configuration',
    recommendation:
      'Allow only the origins that are actually needed, and do not combine a wildcard origin with credentials.',
  },
  'unguarded-mutating-route': {
    severity: 'medium',
    title: 'Mutating route has no visible auth guard',
    recommendation:
      'Check that this route is protected by the project authentication middleware, and attach the guard explicitly if it is not.',
  },
  'insecure-http-url': {
    severity: 'low',
    title: 'Insecure http:// URL appears in source',
    recommendation:
      'Use https:// for anything that leaves the machine, unless the target is genuinely local.',
  },
  'dangerous-html': {
    severity: 'medium',
    title: 'Possible HTML injection sink',
    recommendation:
      'Render text instead of raw HTML, or sanitise it with a maintained sanitiser before inserting it.',
  },
  'weak-hash-or-random': {
    severity: 'low',
    title: 'Possible weak hash or predictable randomness',
    recommendation:
      'Use a modern password hash (bcrypt, scrypt, argon2) and a cryptographic random source for anything security related.',
  },
  'disabled-tls-verification': {
    severity: 'high',
    title: 'Possible disabled TLS certificate verification',
    recommendation:
      'Verify certificates: supply the right CA bundle instead of disabling verification, and never disable it in code that ships.',
  },
};

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Lines longer than this are skipped by the regex rules (untrusted data). */
const MAX_ANALYSED_LINE_CHARS = 2000;

/** A file cannot hold more than maxFileBytes bytes, so this only bounds work. */
const MAX_LINES_PER_FILE = 20_000;

/** Directory segments that are never analysed. */
const EXCLUDED_SEGMENTS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  'coverage',
]);

/** Directories whose contents are fixtures authored by people, not product code. */
const FIXTURE_SEGMENTS: ReadonlySet<string> = new Set([
  'fixtures',
  '__fixtures__',
  'testdata',
  'test-data',
]);

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;

// ---------------------------------------------------------------------------
// Redaction: the same shapes that produce a finding are also what gets hidden
// ---------------------------------------------------------------------------

interface CharRange {
  readonly start: number;
  readonly end: number;
}

/** Provider key shapes. These are findings AND are always redacted. */
const PROVIDER_KEY_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pous]_[A-Za-z0-9]{20,}/g,
  /\bgsk_[A-Za-z0-9]{20,}/g,
  /\bAIza[A-Za-z0-9_-]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN[A-Z ]{0,40}PRIVATE KEY-----/g,
];

/**
 * Shapes that are never reported as their own finding but are still redacted,
 * as defence in depth: if one lands inside an excerpt it must not survive.
 */
const REDACTION_ONLY_PATTERNS: readonly RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/g,
  /\b(?:xox[baprs]-)[A-Za-z0-9-]{10,}/g,
];

const REDACTED = '[redacted]';

/** Assignment keys whose literal value is a secret in practice. */
const ASSIGNMENT_KEY_PATTERN =
  /\b[A-Za-z0-9]*(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|access[_-]?key|private[_-]?key|client[_-]?secret|token)[A-Za-z0-9]*\s*[:=]\s*/gi;

const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set([
  'changeme',
  'change-me',
  'changethis',
  'changeit',
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'string',
  'undefined',
  'null',
  'none',
  'todo',
  'xxx',
  'placeholder',
  'example',
  'dummy',
  'fake',
  'test',
  'your-key-here',
  'your-secret-here',
  'your-api-key',
  'your_password',
]);

interface Literal {
  /** The raw characters of the literal, without surrounding quotes. */
  readonly value: string;
  /** Range of the literal INCLUDING its quotes, used for redaction. */
  readonly start: number;
  readonly end: number;
  readonly quoted: boolean;
  /** True when the literal is assigned to an env-style uppercase key. */
  readonly envStyle: boolean;
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t';
}

/** Reads the literal that follows `start` on one line, or null. */
function readLiteral(line: string, start: number): Literal | null {
  let i = start;
  while (i < line.length) {
    const ch = line[i];
    if (ch === undefined || !isSpace(ch)) break;
    i += 1;
  }
  const first = line[i];
  if (first === undefined) return null;

  const keyPart = line.slice(0, start);
  const envStyle = /\b[A-Z][A-Z0-9_]{2,}\s*[:=]\s*$/.test(keyPart);

  if (first === '"' || first === "'" || first === '`') {
    const close = line.indexOf(first, i + 1);
    if (close < 0) return null;
    return {
      value: line.slice(i + 1, close),
      start: i,
      end: close + 1,
      quoted: true,
      envStyle,
    };
  }

  let end = i;
  while (end < line.length) {
    const ch = line[end];
    if (ch === undefined) break;
    if (isSpace(ch) || ch === ',' || ch === ';' || ch === ')' || ch === '}' || ch === ']') break;
    end += 1;
  }
  if (end === i) return null;
  return { value: line.slice(i, end), start: i, end, quoted: false, envStyle };
}

/** True when a literal is too trivial / too placeholder-ish to be a secret. */
function isNonTrivialLiteral(literal: Literal): boolean {
  const value = literal.value.trim();
  if (value.length < 8) return false;
  if (value.startsWith('<') || value.startsWith('${')) return false;
  if (value.includes('process.env') || value.includes('import.meta')) return false;
  if (/^(?:x+|\.+|\*+|-+|_+)$/i.test(value)) return false;
  if (PLACEHOLDER_VALUES.has(value.toLowerCase())) return false;
  if (/^(?:your|my|the)[-_ ]?[a-z0-9-]*(?:key|secret|token|password|here)/i.test(value)) {
    return false;
  }
  if (literal.quoted) return true;
  // An unquoted value that is obviously code (a call, an expression, a member
  // access) is a reference, not a literal secret.
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) return false;
  // Unquoted literals are only interesting when they cannot be a variable
  // reference: env-style assignments, or a mixed-case/digit value.
  if (literal.envStyle) return /[0-9]/.test(value) || value.length >= 16;
  if (!/[0-9]/.test(value)) return false;
  if (/^[a-z][a-zA-Z0-9]*(?:[._][a-zA-Z0-9]+)*$/.test(value)) return false;
  if (/^[A-Z][A-Z0-9_]*$/.test(value)) return false;
  return true;
}

/** Sets lastIndex to 0 before every scan: these regexes are module-level. */
function matchRanges(line: string, pattern: RegExp): CharRange[] {
  const ranges: CharRange[] = [];
  pattern.lastIndex = 0;
  let match = pattern.exec(line);
  while (match !== null) {
    const text = match[0];
    if (text.length > 0) {
      ranges.push({ start: match.index, end: match.index + text.length });
    } else {
      pattern.lastIndex += 1;
    }
    match = pattern.exec(line);
  }
  return ranges;
}

/** Ranges of provider-shaped keys on a line. */
function providerRanges(line: string): CharRange[] {
  const ranges: CharRange[] = [];
  for (const pattern of PROVIDER_KEY_PATTERNS) {
    ranges.push(...matchRanges(line, pattern));
  }
  return ranges;
}

/** Ranges of assignment literals that look like real values (not placeholders). */
function assignmentRanges(line: string): CharRange[] {
  const ranges: CharRange[] = [];
  ASSIGNMENT_KEY_PATTERN.lastIndex = 0;
  let match = ASSIGNMENT_KEY_PATTERN.exec(line);
  while (match !== null) {
    const literal = readLiteral(line, match.index + match[0].length);
    if (literal !== null && isNonTrivialLiteral(literal)) {
      ranges.push({ start: literal.start, end: literal.end });
    }
    if (match[0].length === 0) ASSIGNMENT_KEY_PATTERN.lastIndex += 1;
    match = ASSIGNMENT_KEY_PATTERN.exec(line);
  }
  return ranges;
}

function mergeRanges(ranges: readonly CharRange[]): CharRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: CharRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.start <= last.end) {
      if (range.end > last.end) merged[merged.length - 1] = { start: last.start, end: range.end };
      continue;
    }
    merged.push({ start: range.start, end: range.end });
  }
  return merged;
}

function applyRanges(line: string, ranges: readonly CharRange[]): string {
  if (ranges.length === 0) return line;
  let out = '';
  let cursor = 0;
  for (const range of ranges) {
    out += line.slice(cursor, range.start);
    out += REDACTED;
    cursor = range.end;
  }
  return out + line.slice(cursor);
}

/**
 * Removes every secret-shaped run from a line and bounds the result. This is
 * the ONLY way an excerpt reaches a finding.
 */
function redactAndBound(line: string): string {
  const ranges = mergeRanges([
    ...providerRanges(line),
    ...assignmentRanges(line),
    ...REDACTION_ONLY_PATTERNS.flatMap((pattern) => matchRanges(line, pattern)),
  ]);
  const redacted = applyRanges(line, ranges);
  const flat = redacted.replace(/\s+/g, ' ').trim();
  const max = APP_TEST_LIMITS.maxEvidenceChars;
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}\u2026`;
}

// ---------------------------------------------------------------------------
// Rule helpers
// ---------------------------------------------------------------------------

/** Lines that are prose (comments) are skipped where that is cheap and safe. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

const EVAL_CALL = /\beval\s*\(/;
const NEW_FUNCTION = /\bnew\s+Function\s*\(/;
const VM_RUN_IN = /\bvm\.runIn[A-Za-z]*\s*\(/;
const CHILD_PROCESS_MENTION = /\bchild_process\b/;
const CHILD_PROCESS_CALL = /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(/;
const EXEC_WITH_TEMPLATE = /\b(?:exec|execSync|execFile|execFileSync)\s*\(\s*`/;
const CONCAT_WITH_VARIABLE = /\+\s*[A-Za-z_$][\w.$]*/;

const SQL_STATEMENT_START = /^\s*(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|WITH)(?:\s|$)/i;
const MAX_SQL_SEGMENT_CHARS = 400;

interface QuotedSegment {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly quote: string;
}

/** Splits a line into its quoted segments, left to right. Linear, no regex. */
function quotedSegments(line: string): QuotedSegment[] {
  const segments: QuotedSegment[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const close = line.indexOf(ch, i + 1);
      if (close < 0) break;
      segments.push({ text: line.slice(i + 1, close), start: i, end: close + 1, quote: ch });
      i = close + 1;
      continue;
    }
    i += 1;
  }
  return segments;
}

function concatenatedAfter(line: string, index: number): boolean {
  let i = index;
  while (i < line.length && isSpace(line[i] ?? '')) i += 1;
  if (line[i] !== '+') return false;
  return /^\s*[A-Za-z_$][\w.$]*/.test(line.slice(i + 1, i + 80));
}

function concatenatedBefore(line: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && isSpace(line[i] ?? '')) i -= 1;
  if (line[i] !== '+') return false;
  let j = i - 1;
  while (j >= 0 && /[\w.$[\]]/.test(line[j] ?? '')) j -= 1;
  return j < i - 1;
}

/** A SQL statement built by interpolation or concatenation on one line. */
function isSqlConcatenation(line: string): boolean {
  if (!line.includes('`') && !line.includes('"') && !line.includes("'")) return false;
  for (const segment of quotedSegments(line)) {
    if (segment.text.length > MAX_SQL_SEGMENT_CHARS) continue;
    if (!SQL_STATEMENT_START.test(segment.text)) continue;
    if (segment.quote === '`' && segment.text.includes('${')) return true;
    if (concatenatedAfter(line, segment.end)) return true;
    if (concatenatedBefore(line, segment.start)) return true;
  }
  return false;
}

const CORS_WILDCARD_ORIGIN = /\borigin\s*:\s*['"]\*['"]/;
const CORS_WILDCARD_HEADER = /Access-Control-Allow-Origin['"]?\s*(?::|=|,)\s*['"]\*/;
const CORS_ORIGIN_TRUE = /\borigin\s*:\s*true\b/;
const CORS_CREDENTIALS_TRUE = /\bcredentials\s*:\s*true\b/;
const CORS_NO_ARGUMENTS = /\bcors\s*\(\s*\)/;
const CORS_CREDENTIALS_WINDOW = 10;

const ALLOWED_HTTP_HOSTS: readonly string[] = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '[::1]',
  'example.com',
  'example.org',
  'w3.org',
];

const HOST_SHAPE = /^[A-Za-z0-9.\-_[\]:]+/;

function hostOf(url: string): string {
  const raw = HOST_SHAPE.exec(url)?.[0] ?? '';
  if (raw.length === 0) return '';
  const bracketed = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw;
  const withoutPort = bracketed.replace(/:\d+$/, '');
  return withoutPort.toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
}

function isAllowedHost(host: string): boolean {
  for (const allowed of ALLOWED_HTTP_HOSTS) {
    if (host === allowed || host.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

/** True when the line contains a hard-coded, non-local http:// URL. */
function hasInsecureHttpUrl(line: string): boolean {
  let index = line.indexOf('http://');
  while (index >= 0) {
    const previous = index > 0 ? line[index - 1] : undefined;
    if (previous !== undefined && /[A-Za-z0-9]/.test(previous)) {
      index = line.indexOf('http://', index + 7);
      continue;
    }
    const host = hostOf(line.slice(index + 7, index + 7 + 120));
    if (host.length > 0 && !isAllowedHost(host)) return true;
    index = line.indexOf('http://', index + 7);
  }
  return false;
}

const DANGEROUS_HTML = [
  /dangerouslySetInnerHTML/,
  /\binnerHTML\s*=/,
  /\bdocument\.write(?:ln)?\s*\(/,
] as const;

const WEAK_HASH = /createHash\s*\(\s*['"](?:md5|sha1)['"]/i;
const WEAK_RANDOM = /Math\.random\s*\(\s*\)/;
const RANDOM_SENSITIVE_CONTEXT =
  /(?:token|session|password|passwd|secret|api[_-]?key|apikey|nonce|salt|otp|csrf|auth|credential|key)/i;

const REJECT_UNAUTHORIZED_FALSE = /rejectUnauthorized\s*:\s*false/;
const NODE_TLS_DISABLED = /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0['"]?/;

// ---------------------------------------------------------------------------
// Path handling
// ---------------------------------------------------------------------------

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function pathSegments(path: string): string[] {
  return normalizePath(path)
    .split('/')
    .filter((segment) => segment.length > 0);
}

function isExcludedPath(path: string): boolean {
  return pathSegments(path).some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

function isFixtureOrTestPath(path: string): boolean {
  const segments = pathSegments(path);
  const base = segments[segments.length - 1] ?? '';
  if (TEST_FILE_PATTERN.test(base)) return true;
  return segments.some((segment) => FIXTURE_SEGMENTS.has(segment.toLowerCase()));
}

const ENV_FILE_PATTERN = /^\.env(?:\.(?:local|production|development|staging|test|preview))?$/;

function isEnvFileName(path: string): boolean {
  const segments = pathSegments(path);
  const base = segments[segments.length - 1] ?? '';
  return ENV_FILE_PATTERN.test(base.toLowerCase());
}

const ENV_ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** The first line of a .env file that really sets a value, or null. */
function firstEnvAssignment(lines: readonly string[]): { key: string; line: number } | null {
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const match = ENV_ASSIGNMENT.exec(raw);
    if (match === null) continue;
    const key = match[1] ?? '';
    const value = (match[2] ?? '').trim();
    if (key.length === 0 || value.length === 0) continue;
    if (value === '""' || value === "''") continue;
    return { key, line: index + 1 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

interface Candidate {
  readonly rule: SecurityRuleId;
  readonly severity: BugSeverity;
  readonly title: string;
  readonly file: string;
  readonly line: number;
  readonly evidence: string;
  readonly recommendation: string;
}

const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Runs every static security check over the files and returns SUSPECTED
 * findings, most severe first. Pure: the same inputs always give the same
 * output, and no input can make it throw or run unbounded.
 */
export function runSecurityChecks(
  files: readonly InspectableFile[],
  inspection: AppInspection,
): readonly SecurityFinding[] {
  const candidates = new Map<string, Candidate>();

  const add = (candidate: Candidate): void => {
    const key = `${candidate.rule}\u0000${candidate.file}\u0000${candidate.line}`;
    const existing = candidates.get(key);
    if (existing === undefined) {
      candidates.set(key, candidate);
      return;
    }
    if (SEVERITY_RANK[candidate.severity] < SEVERITY_RANK[existing.severity]) {
      candidates.set(key, candidate);
    }
  };

  const analysed = files.filter((file) => !isExcludedPath(file.path));
  const bounded = analysed.slice(0, APP_TEST_LIMITS.maxFiles);

  for (const file of bounded) {
    const text = file.text;
    if (text === null) {
      // A secret-shaped file is listed but never read, so its values cannot be
      // checked. The file being committed is the finding, and the wording says
      // that its contents were not looked at.
      const withheld = normalizePath(file.path);
      if (isEnvFileName(withheld)) {
        add({
          rule: SECURITY_RULES.envFileCommitted,
          severity: RULE_META['env-file-committed'].severity,
          title: 'An environment file is present in the project; its contents were not read',
          file: withheld,
          line: 1,
          evidence: '(contents withheld: files that may hold secrets are never read)',
          recommendation: RULE_META['env-file-committed'].recommendation,
        });
      }
      continue;
    }
    const path = normalizePath(file.path);
    const content =
      text.length > APP_TEST_LIMITS.maxFileBytes
        ? text.slice(0, APP_TEST_LIMITS.maxFileBytes)
        : text;
    const lines = content.split('\n');

    // Rule 2: a committed .env file (its values are never echoed).
    if (isEnvFileName(path)) {
      const assignment = firstEnvAssignment(lines);
      if (assignment !== null) {
        add({
          rule: SECURITY_RULES.envFileCommitted,
          severity: RULE_META['env-file-committed'].severity,
          title: RULE_META['env-file-committed'].title,
          file: path,
          line: assignment.line,
          evidence: redactAndBound(`${assignment.key}=${REDACTED}`),
          recommendation: RULE_META['env-file-committed'].recommendation,
        });
      }
    }

    const assignmentRuleApplies = !isFixtureOrTestPath(path);
    const mentionsChildProcess = CHILD_PROCESS_MENTION.test(content);
    const limit = Math.min(lines.length, MAX_LINES_PER_FILE);

    for (let index = 0; index < limit; index += 1) {
      const line = (lines[index] ?? '').replace(/\r$/, '');
      const lineNumber = index + 1;
      // Untrusted, potentially minified text: bounded work only.
      if (line.length > MAX_ANALYSED_LINE_CHARS) continue;

      // Rule 1: hardcoded secrets. Provider keys count everywhere; the
      // assignment shape is skipped in tests and fixtures.
      const hasProviderKey = providerRanges(line).length > 0;
      if (hasProviderKey || (assignmentRuleApplies && assignmentRanges(line).length > 0)) {
        add({
          rule: SECURITY_RULES.hardcodedSecret,
          severity: hasProviderKey ? 'critical' : RULE_META['hardcoded-secret'].severity,
          title: RULE_META['hardcoded-secret'].title,
          file: path,
          line: lineNumber,
          evidence: redactAndBound(line),
          recommendation: RULE_META['hardcoded-secret'].recommendation,
        });
      }

      const isComment = COMMENT_LINE.test(line);

      // Rule 3: dynamic code execution.
      if (
        !isComment &&
        (EVAL_CALL.test(line) ||
          NEW_FUNCTION.test(line) ||
          VM_RUN_IN.test(line) ||
          (mentionsChildProcess &&
            CHILD_PROCESS_CALL.test(line) &&
            (EXEC_WITH_TEMPLATE.test(line) ||
              CONCAT_WITH_VARIABLE.test(line) ||
              line.includes('${'))))
      ) {
        add({
          rule: SECURITY_RULES.dynamicCodeExecution,
          severity: RULE_META['dynamic-code-execution'].severity,
          title: RULE_META['dynamic-code-execution'].title,
          file: path,
          line: lineNumber,
          evidence: redactAndBound(line),
          recommendation: RULE_META['dynamic-code-execution'].recommendation,
        });
      }

      // Rule 4: SQL built from strings.
      if (isSqlConcatenation(line)) {
        add({
          rule: SECURITY_RULES.sqlStringConcat,
          severity: RULE_META['sql-string-concat'].severity,
          title: RULE_META['sql-string-concat'].title,
          file: path,
          line: lineNumber,
          evidence: redactAndBound(line),
          recommendation: RULE_META['sql-string-concat'].recommendation,
        });
      }

      // Rule 5: permissive CORS.
      const corsHit =
        CORS_WILDCARD_ORIGIN.test(line) ||
        CORS_WILDCARD_HEADER.test(line) ||
        (inspection.hasAuth && CORS_NO_ARGUMENTS.test(line)) ||
        (CORS_ORIGIN_TRUE.test(line) && credentialsWithinWindow(lines, index, limit));
      if (corsHit) {
        add({
          rule: SECURITY_RULES.permissiveCors,
          severity: RULE_META['permissive-cors'].severity,
          title: RULE_META['permissive-cors'].title,
          file: path,
          line: lineNumber,
          evidence: redactAndBound(line),
          recommendation: RULE_META['permissive-cors'].recommendation,
        });
      }

      // Rule 7: insecure http:// URLs (prose lines are skipped).
      if (!isComment && hasInsecureHttpUrl(line)) {
        add({
          rule: SECURITY_RULES.insecureHttpUrl,
          severity: RULE_META['insecure-http-url'].severity,
          title: RULE_META['insecure-http-url'].title,
          file: path,
          line: lineNumber,
          evidence: redactAndBound(line),
          recommendation: RULE_META['insecure-http-url'].recommendation,
        });
      }

      // Rule 8: dangerous HTML sinks.
      if (!isComment && DANGEROUS_HTML.some((pattern) => pattern.test(line))) {
        add({
          rule: SECURITY_RULES.dangerousHtml,
          severity: RULE_META['dangerous-html'].severity,
          title: RULE_META['dangerous-html'].title,
          file: path,
          line: lineNumber,
          evidence: redactAndBound(line),
          recommendation: RULE_META['dangerous-html'].recommendation,
        });
      }

      // Rule 9: weak hashes and predictable randomness.
      if (WEAK_HASH.test(line) || (WEAK_RANDOM.test(line) && RANDOM_SENSITIVE_CONTEXT.test(line))) {
        add({
          rule: SECURITY_RULES.weakHashOrRandom,
          severity: RULE_META['weak-hash-or-random'].severity,
          title: RULE_META['weak-hash-or-random'].title,
          file: path,
          line: lineNumber,
          evidence: redactAndBound(line),
          recommendation: RULE_META['weak-hash-or-random'].recommendation,
        });
      }

      // Rule 10: disabled TLS verification.
      if (REJECT_UNAUTHORIZED_FALSE.test(line) || NODE_TLS_DISABLED.test(line)) {
        add({
          rule: SECURITY_RULES.disabledTlsVerification,
          severity: RULE_META['disabled-tls-verification'].severity,
          title: RULE_META['disabled-tls-verification'].title,
          file: path,
          line: lineNumber,
          evidence: redactAndBound(line),
          recommendation: RULE_META['disabled-tls-verification'].recommendation,
        });
      }
    }
  }

  // Rule 6: mutating API routes with no visible guard, only when the project
  // does have authentication (otherwise the absence proves nothing).
  if (inspection.hasAuth) {
    for (const route of inspection.apiRoutes.slice(0, APP_TEST_LIMITS.maxRoutes)) {
      const method = route.method.toUpperCase();
      if (!MUTATING_METHODS.has(method) || route.guarded !== false) continue;
      const file = normalizePath(route.file);
      add({
        rule: SECURITY_RULES.unguardedMutatingRoute,
        severity: RULE_META['unguarded-mutating-route'].severity,
        title: `${method} ${route.path} has no visible auth guard`,
        file,
        line: route.line,
        evidence: redactAndBound(
          `${method} ${route.path} - no authentication guard is visible on this route handler`,
        ),
        recommendation: RULE_META['unguarded-mutating-route'].recommendation,
      });
    }
  }

  const ordered = [...candidates.values()].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
    if (a.evidence === b.evidence) return 0;
    return a.evidence < b.evidence ? -1 : 1;
  });

  const counters = new Map<string, number>();
  const findings: SecurityFinding[] = [];
  for (const candidate of ordered.slice(0, APP_TEST_LIMITS.maxFindings)) {
    const next = (counters.get(candidate.rule) ?? 0) + 1;
    counters.set(candidate.rule, next);
    findings.push({
      id: `sec-${candidate.rule}-${next}`,
      rule: candidate.rule,
      severity: candidate.severity,
      title: candidate.title,
      file: candidate.file,
      line: candidate.line,
      evidence: candidate.evidence,
      recommendation: candidate.recommendation,
    });
  }
  return findings;
}

/** True when `credentials: true` sits within the small window after `index`. */
function credentialsWithinWindow(lines: readonly string[], index: number, limit: number): boolean {
  const start = Math.max(0, index - CORS_CREDENTIALS_WINDOW);
  const end = Math.min(limit, index + 1 + CORS_CREDENTIALS_WINDOW);
  for (let i = start; i < end; i += 1) {
    if (CORS_CREDENTIALS_TRUE.test(lines[i] ?? '')) return true;
  }
  return false;
}
