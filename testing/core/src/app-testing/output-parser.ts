/**
 * Test-output parsing for the AI Application Testing Agent (Step 39).
 *
 * Turns the captured stdout/stderr text of a test run into per-test
 * `AppTestResult`s for the four runners the agent knows how to detect. The work
 * is PURE: no filesystem, no process, no network, no clock, no randomness, and
 * the module never throws — malformed or hostile output simply yields fewer
 * results plus an honest `note`.
 *
 * Everything here is pattern matching over UNTRUSTED text, so three rules shape
 * the implementation:
 *
 *  1. Only reporter-SHAPED lines anchored at the start of a line (after
 *     indentation) can create a test. Text inside a failure detail block is
 *     captured as opaque error text and is never re-scanned, so a line such as
 *     `✓ everything is fine` printed inside an assertion message cannot turn a
 *     failure into a pass. Instructions in the output are never followed.
 *  2. A missing test is never invented. When the summary line counts more tests
 *     than the per-test lines did, the mismatch goes into `note`; nothing is
 *     fabricated to fill the gap. The one synthesis the parser does perform is
 *     an explicit, labelled fallback: a file-level line (`✓ file.test.ts (3
 *     tests)`) with no individual test lines under it becomes ONE file-level
 *     result, never three fake tests.
 *  3. Every part of the output is bounded: 400 KB of input, `maxTests * 2`
 *     results, 200-character titles, 600-character errors, and lines longer
 *     than 2000 characters are truncated before matching so no pattern can be
 *     made to backtrack over a minified blob.
 *
 * Error text is scrubbed of secret-shaped runs (`sk-...`, `ghp_...`, `gsk_...`,
 * `AIza...`, `AKIA...`, bearer tokens, `password=...`) before it is stored.
 * Titles are scrubbed too: a test name is attacker-controlled text as well.
 */

import {
  APP_TEST_LIMITS,
  type AppTestOutcome,
  type AppTestResult,
  type TestRunner,
} from './types.js';

/** What the parser read out of one captured run. */
export interface ParsedTestOutput {
  readonly tests: readonly AppTestResult[];
  /** False when the text does not look like this runner's output at all. */
  readonly recognised: boolean;
  /** True when the output was larger than the 400 KB ceiling. */
  readonly truncated: boolean;
  /** Plain words about what was parsed, what was cut and what disagreed. */
  readonly note: string;
}

/** Only the first 400 KB of captured output is read. */
const MAX_OUTPUT_CHARS = 400 * 1024;
/** Hard cap on returned results (twice the report's limit, per the spec). */
const MAX_TESTS = APP_TEST_LIMITS.maxTests * 2;
const MAX_TITLE_CHARS = 200;
const MAX_ERROR_CHARS = 600;
/** Assertion message + up to eight stack lines. */
const MAX_ERROR_LINES = 9;
/** Upper bound on distinct failure blocks remembered for error attachment. */
const MAX_FAILURES = MAX_TESTS * 2;
/** Upper bound on lines consumed after a failure header. */
const MAX_DETAIL_LINES = 16;
/** Longer lines are cut before pattern matching (no runaway backtracking). */
const MAX_SCAN_LINE_CHARS = 2_000;
const DEFAULT_SKIP_REASON = 'skipped without a reason in the output';

const RUNNER_LABEL: Readonly<Record<Exclude<TestRunner, 'none'>, string>> = {
  vitest: 'Vitest',
  jest: 'Jest',
  'node-test': 'node:test',
  mocha: 'Mocha',
};

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/** Secret-shaped runs. Deliberately broad: when in doubt, redact. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bgho_[A-Za-z0-9]{20,}/g,
  /\bgsk_[A-Za-z0-9]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

/** `password=...`, `password: ...`, `PASSWORD = "..."` → value replaced. */
const PASSWORD_PATTERN = /(\bpassword\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',;]+)/gi;

/** Replaces secret-shaped values with a fixed marker. */
function redactSecrets(input: string): string {
  let output = input;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, '[redacted]');
  }
  return output.replace(PASSWORD_PATTERN, (_match, prefix: string) => `${prefix}[redacted]`);
}

// ---------------------------------------------------------------------------
// Terminal text handling
// ---------------------------------------------------------------------------

/* eslint-disable no-control-regex -- ANSI escapes are exactly these control characters. */
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const ANSI_CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OTHER = /\u001b[@-Z\\-_]/g;
/* eslint-enable no-control-regex */

/** Strips terminal colour/control sequences (Vitest and Jest both emit them). */
function stripAnsi(input: string): string {
  return input.replace(ANSI_OSC, '').replace(ANSI_CSI, '').replace(ANSI_OTHER, '');
}

/** Normalises newlines so `\r`-based progress updates do not merge lines. */
function toLines(input: string): string[] {
  return input.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function leadingSpaces(line: string): number {
  let count = 0;
  while (count < line.length && (line[count] === ' ' || line[count] === '\t')) count += 1;
  return count;
}

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

interface DraftTest {
  order: number;
  title: string;
  outcome: AppTestOutcome;
  durationMs: number | null;
  skipReason: string | null;
  error: string | null;
  file: string | null;
}

interface DraftFailure {
  order: number;
  title: string;
  file: string | null;
  detailLines: readonly string[];
}

interface SummaryCounts {
  total: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
}

interface Collector {
  readonly drafts: DraftTest[];
  readonly failures: DraftFailure[];
  readonly summary: SummaryCounts;
  sawStructure: boolean;
  /** How many test lines were seen, even past the returned cap. */
  parsedCount: number;
  /** File-level lines that had no individual test lines under them. */
  fileLevelOnly: number;
  /** Failure blocks that became their own result (no matching test line). */
  syntheticCount: number;
  nextOrder: number;
}

function createCollector(): Collector {
  return {
    drafts: [],
    failures: [],
    summary: { total: null, passed: null, failed: null, skipped: null },
    sawStructure: false,
    parsedCount: 0,
    fileLevelOnly: 0,
    syntheticCount: 0,
    nextOrder: 0,
  };
}

/**
 * Records a failure block. Bounded: failure blocks exist only to carry error
 * text for results that can actually be reported.
 */
function addFailure(
  collector: Collector,
  title: string,
  file: string | null,
  detailLines: readonly string[],
): void {
  const order = collector.nextOrder;
  collector.nextOrder += 1;
  if (collector.failures.length >= MAX_FAILURES) return;
  collector.failures.push({ order, title, file, detailLines });
}

/**
 * Records one parsed test. `order` is the position of the line that produced it
 * so results stay in output order even when a file-level fallback is added at
 * the end of a scan.
 */
function addDraft(collector: Collector, order: number, draft: Omit<DraftTest, 'order'>): void {
  collector.parsedCount += 1;
  if (collector.drafts.length >= MAX_TESTS) return;
  collector.drafts.push({ order, ...draft });
}

// ---------------------------------------------------------------------------
// Small parsing helpers
// ---------------------------------------------------------------------------

function boundTitle(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  const scrubbed = redactSecrets(flat);
  return scrubbed.length <= MAX_TITLE_CHARS
    ? scrubbed
    : `${scrubbed.slice(0, MAX_TITLE_CHARS - 1)}\u2026`;
}

/** Splits a trailing `12ms` / `1.2s` (or `(4 ms)`) off a test name. */
function splitDuration(
  payload: string,
  tail: RegExp,
): { readonly title: string; readonly durationMs: number | null } {
  const match = tail.exec(payload);
  if (!match) return { title: payload, durationMs: null };
  const value = Number(match[1] ?? '');
  const unit = (match[2] ?? 'ms').toLowerCase();
  if (!Number.isFinite(value)) return { title: payload.slice(0, match.index), durationMs: null };
  const durationMs = unit === 's' ? Math.round(value * 1000) : value;
  return { title: payload.slice(0, match.index), durationMs };
}

/** `suite > test` / `suite › test` → the last name segment. */
function lastSegment(title: string): string {
  const parts = title
    .split(/\s*(?:>|\u203a|\u00bb)\s*/)
    .map((part) => normaliseTitle(part))
    .filter((part) => part !== '');
  return parts.length > 0 ? (parts[parts.length - 1] ?? '') : normaliseTitle(title);
}

function normaliseTitle(title: string): string {
  return title
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^['"`]+/, '')
    .replace(/['"`]+$/, '')
    .toLowerCase();
}

function parseCounts(text: string): {
  passed?: number;
  failed?: number;
  skipped?: number;
  total?: number;
} {
  const out: { passed?: number; failed?: number; skipped?: number; total?: number } = {};
  const pattern = /(\d+)\s+(failed|failing|passed|passing|skipped|pending|todo|total)\b/g;
  let match = pattern.exec(text);
  while (match !== null) {
    const value = Number(match[1] ?? '0');
    const word = match[2] ?? '';
    if (Number.isFinite(value)) {
      if (word === 'passed' || word === 'passing') out.passed = value;
      if (word === 'failed' || word === 'failing') out.failed = value;
      if (word === 'skipped' || word === 'pending' || word === 'todo') {
        out.skipped = (out.skipped ?? 0) + value;
      }
      if (word === 'total') out.total = value;
    }
    match = pattern.exec(text);
  }
  return out;
}

function mergeSummary(collector: Collector, counts: ReturnType<typeof parseCounts>): void {
  const summary = collector.summary;
  if (counts.passed !== undefined) summary.passed = counts.passed;
  if (counts.failed !== undefined) summary.failed = counts.failed;
  if (counts.skipped !== undefined) summary.skipped = counts.skipped;
  if (counts.total !== undefined) summary.total = counts.total;
}

/**
 * Reads the lines that follow a failure header.
 *
 * The consumed lines are opaque: they are only ever used as error text, so a
 * reporter-shaped line printed inside an assertion message is never treated as
 * a result.
 */
function captureDetail(
  lines: readonly string[],
  start: number,
  isTerminator: (line: string, sawBlank: boolean) => boolean,
  maxLines: number = MAX_DETAIL_LINES,
): { readonly detailLines: readonly string[]; readonly next: number } {
  const detailLines: string[] = [];
  let index = start;
  let sawBlank = false;
  while (index < lines.length && detailLines.length < maxLines) {
    const line = lines[index] ?? '';
    const scanned = line.length > MAX_SCAN_LINE_CHARS ? line.slice(0, MAX_SCAN_LINE_CHARS) : line;
    if (isTerminator(scanned, sawBlank)) break;
    if (scanned.trim() === '') sawBlank = true;
    detailLines.push(scanned);
    index += 1;
  }
  return { detailLines, next: index };
}

/** Separator rules, code-frame gutters and diff markers are not messages. */
function isNoiseLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  if (/^[\u2500-\u257f=_~-]{3,}$/.test(trimmed)) return true;
  if (/^[>+]?\s*\d+\s*\|/.test(trimmed)) return true;
  if (/^[-+]?\s*\d*\s*\|\s*\^+$/.test(trimmed)) return true;
  return false;
}

/** A frame line: `❯ file:1:2`, `at fn (file:1:2)`, or a bare `...:1:2`. */
function isStackLine(line: string): boolean {
  return /^\s*(?:\u276f|at\s|\u203a|@)/.test(line) || /:\d+:\d+\)?\s*$/.test(line);
}

/**
 * Assertion message plus up to eight lines of the relevant stack, scrubbed and
 * bounded. Separator rules, code-frame gutters and TAP scaffolding are dropped
 * so the message and the frames are what survives the character budget.
 */
function buildError(detailLines: readonly string[]): string | null {
  const cleaned: string[] = [];
  for (const raw of detailLines) {
    if (isNoiseLine(raw)) continue;
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '') continue;
    cleaned.push(line);
  }
  if (cleaned.length === 0) return null;

  const first = cleaned[0] ?? '';
  const rest = cleaned.slice(1);
  const stacks = rest.filter(isStackLine);
  const others = rest.filter((line) => !isStackLine(line));
  const kept: string[] = [first];

  if (stacks.length > 0 && kept.length + others.length + stacks.length > MAX_ERROR_LINES) {
    kept.push(...others.slice(0, MAX_ERROR_LINES - 3), ...stacks.slice(0, 2));
  } else {
    for (const line of [...others, ...stacks]) {
      if (kept.length >= MAX_ERROR_LINES) break;
      kept.push(line);
    }
  }

  const text = redactSecrets(kept.join('\n')).trim();
  if (text === '') return null;
  return text.length <= MAX_ERROR_CHARS ? text : `${text.slice(0, MAX_ERROR_CHARS - 1)}\u2026`;
}

/** Removes TAP YAML scaffolding, keeping the message and the stack. */
function cleanTapDetail(detailLines: readonly string[]): string[] {
  const out: string[] = [];
  let inStack = false;
  for (const raw of detailLines) {
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (trimmed === '' || trimmed === '---' || trimmed === '...') continue;
    if (/^stack:\s*\|?-?\s*$/.test(trimmed)) {
      inStack = true;
      continue;
    }
    if (/^(duration_ms|type|location|todo|skip|failureType|code):/.test(trimmed)) {
      inStack = false;
      continue;
    }
    const field = /^(error|operator|expected|actual):\s*(.*)$/.exec(trimmed);
    if (field) {
      const name = field[1] ?? '';
      const value = (field[2] ?? '').replace(/^['"]/, '').replace(/['"]$/, '');
      if (name === 'error') out.push(value);
      else if (name === 'expected' || name === 'actual') out.push(`${name}: ${value}`);
      inStack = false;
      continue;
    }
    out.push(inStack ? trimmed : line.trim());
  }
  return out;
}

// ---------------------------------------------------------------------------
// Vitest
// ---------------------------------------------------------------------------

const VITEST_FILE_LINE =
  /^\s{0,4}([✓✔×✗❯↓])\s{1,3}(\S.*?\.(?:test|spec)\.[cm]?[jt]sx?)\s+\((\d+)\s+tests?([^)]*)\)(?:\s+(\d+(?:\.\d+)?)\s*(ms|s))?\s*$/;
const VITEST_RESULT_LINE = /^\s{1,10}([✓✔×✗✕↓])\s{1,3}(\S.*)$/;
const VITEST_FAIL_HEADER = /^\s{0,2}FAIL\s{2,}(\S.*)$/;
const VITEST_TESTS_SUMMARY = /^\s*Tests\s+(\S.*)$/;
const VITEST_FILES_SUMMARY = /^\s*Test Files\s+(\S.*)$/;
const VITEST_DURATION_TAIL = /\s+(\d+(?:\.\d+)?)\s*(ms|s)\s*$/;
const VITEST_TOTAL_TAIL = /\((\d+)\)\s*$/;

function vitestOutcome(marker: string): AppTestOutcome | null {
  if (marker === '✓' || marker === '✔') return 'passed';
  if (marker === '×' || marker === '✗' || marker === '✕') return 'failed';
  if (marker === '↓') return 'skipped';
  return null;
}

function isVitestDetailTerminator(line: string, sawBlank: boolean): boolean {
  if (/^\s{0,2}FAIL\s{2,}/.test(line)) return true;
  if (VITEST_TESTS_SUMMARY.test(line)) return true;
  if (VITEST_FILES_SUMMARY.test(line)) return true;
  if (/^\s*(Duration|Start at|Snapshots|RUN)\b/.test(line)) return true;
  // A blank line followed by a new file section ends the failure detail.
  if (sawBlank && VITEST_FILE_LINE.test(line)) return true;
  return false;
}

interface FileHeader {
  order: number;
  file: string;
  failed: boolean;
  durationMs: number | null;
  children: number;
}

function scanVitest(lines: readonly string[], collector: Collector): void {
  const headers: FileHeader[] = [];
  let currentFile: string | null = null;
  let currentHeader: FileHeader | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    if (raw.trim() === '') continue;
    const line = raw.length > MAX_SCAN_LINE_CHARS ? raw.slice(0, MAX_SCAN_LINE_CHARS) : raw;

    if (/^\s*RUN\s+v\d/.test(line)) {
      collector.sawStructure = true;
      continue;
    }

    const failHeader = VITEST_FAIL_HEADER.exec(line);
    if (failHeader !== null) {
      collector.sawStructure = true;
      const captured = captureDetail(lines, index + 1, isVitestDetailTerminator);
      addFailure(collector, (failHeader[1] ?? '').trim(), currentFile, captured.detailLines);
      index = captured.next - 1;
      continue;
    }

    const testsSummary = VITEST_TESTS_SUMMARY.exec(line);
    if (testsSummary !== null) {
      collector.sawStructure = true;
      const body = testsSummary[1] ?? '';
      const counts = parseCounts(body);
      const total = VITEST_TOTAL_TAIL.exec(body);
      mergeSummary(collector, {
        ...counts,
        ...(total !== null ? { total: Number(total[1]) } : {}),
      });
      continue;
    }

    const filesSummary = VITEST_FILES_SUMMARY.exec(line);
    if (filesSummary !== null) {
      collector.sawStructure = true;
      continue;
    }

    if (/^\s*(Duration|Start at|Snapshots)\b/.test(line)) {
      collector.sawStructure = true;
      continue;
    }

    const fileLine = VITEST_FILE_LINE.exec(line);
    if (fileLine !== null) {
      collector.sawStructure = true;
      const rawDuration = fileLine[5];
      const rawUnit = (fileLine[6] ?? 'ms').toLowerCase();
      const header: FileHeader = {
        order: collector.nextOrder++,
        file: (fileLine[2] ?? '').trim(),
        failed: /failed/.test(fileLine[4] ?? ''),
        durationMs:
          rawDuration === undefined
            ? null
            : Math.round(Number(rawDuration) * (rawUnit === 's' ? 1000 : 1)),
        children: 0,
      };
      headers.push(header);
      currentHeader = header;
      currentFile = header.file;
      continue;
    }

    const result = VITEST_RESULT_LINE.exec(line);
    if (result !== null) {
      const outcome = vitestOutcome(result[1] ?? '');
      if (outcome === null) continue;
      const payload = (result[2] ?? '').trim();
      if (payload === '' || payload.startsWith('(')) continue;
      const { title, durationMs } = splitDuration(payload, VITEST_DURATION_TAIL);
      const bounded = boundTitle(title);
      if (bounded === '') continue;
      collector.sawStructure = true;
      if (currentHeader !== null) currentHeader.children += 1;
      addDraft(collector, collector.nextOrder++, {
        title: bounded,
        outcome,
        durationMs,
        skipReason: null,
        error: null,
        file: currentFile,
      });
      continue;
    }
  }

  // A file line with no individual test lines becomes ONE file-level result.
  for (const header of headers) {
    if (header.children > 0) continue;
    collector.fileLevelOnly += 1;
    addDraft(collector, header.order, {
      title: boundTitle(header.file),
      outcome: header.failed ? 'failed' : 'passed',
      durationMs: header.durationMs,
      skipReason: null,
      error: null,
      file: header.file,
    });
  }
}

// ---------------------------------------------------------------------------
// Jest
// ---------------------------------------------------------------------------

const JEST_FILE_LINE = /^(PASS|FAIL)\s+(\S.*?)\s*$/;
const JEST_RESULT_LINE = /^\s{1,10}([✓✔✕✗×○◯✎])\s{1,3}(\S.*)$/;
const JEST_FAIL_HEADER = /^\s{0,4}●\s{1,3}(\S.*)$/;
const JEST_TESTS_SUMMARY = /^\s*Tests:\s*(\S.*)$/;
const JEST_SUITES_SUMMARY = /^\s*Test Suites:\s*(\S.*)$/;
const JEST_DURATION_TAIL = /\s+\((\d+(?:\.\d+)?)\s*(ms|s)\)\s*$/;

function jestOutcome(marker: string): AppTestOutcome | null {
  if (marker === '✓' || marker === '✔') return 'passed';
  if (marker === '✕' || marker === '✗' || marker === '×') return 'failed';
  if (marker === '○' || marker === '◯' || marker === '✎') return 'skipped';
  return null;
}

function isJestDetailTerminator(line: string, sawBlank: boolean): boolean {
  if (JEST_FAIL_HEADER.test(line)) return true;
  if (JEST_TESTS_SUMMARY.test(line)) return true;
  if (JEST_SUITES_SUMMARY.test(line)) return true;
  if (/^\s*(Snapshots:|Time:|Ran all test suites)/.test(line)) return true;
  if (JEST_FILE_LINE.test(line)) return true;
  if (sawBlank && /^\s{0,4}(Test Suites|Tests):/.test(line)) return true;
  return false;
}

interface JestFileHeader {
  order: number;
  file: string;
  failed: boolean;
  children: number;
}

function scanJest(lines: readonly string[], collector: Collector): void {
  const headers: JestFileHeader[] = [];
  let currentFile: string | null = null;
  let currentHeader: JestFileHeader | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    if (raw.trim() === '') continue;
    const line = raw.length > MAX_SCAN_LINE_CHARS ? raw.slice(0, MAX_SCAN_LINE_CHARS) : raw;

    const failHeader = JEST_FAIL_HEADER.exec(line);
    if (failHeader !== null) {
      collector.sawStructure = true;
      if (/^console$/i.test((failHeader[1] ?? '').trim())) continue;
      const captured = captureDetail(lines, index + 1, isJestDetailTerminator);
      addFailure(collector, (failHeader[1] ?? '').trim(), currentFile, captured.detailLines);
      index = captured.next - 1;
      continue;
    }

    const testsSummary = JEST_TESTS_SUMMARY.exec(line);
    if (testsSummary !== null) {
      collector.sawStructure = true;
      mergeSummary(collector, parseCounts(testsSummary[1] ?? ''));
      continue;
    }

    if (JEST_SUITES_SUMMARY.test(line)) {
      collector.sawStructure = true;
      continue;
    }

    if (/^\s*(Snapshots:|Time:|Ran all test suites)/.test(line)) {
      collector.sawStructure = true;
      continue;
    }

    const fileLine = JEST_FILE_LINE.exec(line);
    if (fileLine !== null) {
      collector.sawStructure = true;
      const header: JestFileHeader = {
        order: collector.nextOrder++,
        file: (fileLine[2] ?? '').trim(),
        failed: fileLine[1] === 'FAIL',
        children: 0,
      };
      headers.push(header);
      currentHeader = header;
      currentFile = header.file;
      continue;
    }

    const result = JEST_RESULT_LINE.exec(line);
    if (result !== null) {
      const outcome = jestOutcome(result[1] ?? '');
      if (outcome === null) continue;
      const payload = (result[2] ?? '').trim();
      if (payload === '') continue;
      const { title, durationMs } = splitDuration(payload, JEST_DURATION_TAIL);
      const bounded = boundTitle(title);
      if (bounded === '') continue;
      collector.sawStructure = true;
      if (currentHeader !== null) currentHeader.children += 1;
      addDraft(collector, collector.nextOrder++, {
        title: bounded,
        outcome,
        durationMs,
        skipReason: null,
        error: null,
        file: currentFile,
      });
      continue;
    }
  }

  for (const header of headers) {
    if (header.children > 0) continue;
    collector.fileLevelOnly += 1;
    addDraft(collector, header.order, {
      title: boundTitle(header.file),
      outcome: header.failed ? 'failed' : 'passed',
      durationMs: null,
      skipReason: null,
      error: null,
      file: header.file,
    });
  }
}

// ---------------------------------------------------------------------------
// node:test (spec and TAP)
// ---------------------------------------------------------------------------

const NODE_SPEC_RESULT = /^(\s{0,10})([✔✖✗﹣-])\s{1,3}(\S.*)$/;
const NODE_TAP_RESULT = /^(\s*)(not ok|ok)\b\s*(\d+)?\s*[-–]?\s*(\S.*)$/;
const NODE_TAP_PLAN = /^1\.\.(\d+)\s*$/;
const NODE_SPEC_TESTS = /^ℹ\s+tests\s+(\d+)/;
const NODE_SPEC_PASS = /^ℹ\s+pass\s+(\d+)/;
const NODE_SPEC_FAIL = /^ℹ\s+fail\s+(\d+)/;
const NODE_SPEC_SKIP = /^ℹ\s+skipped\s+(\d+)/;
const NODE_TAP_TESTS = /^#\s+tests\s+(\d+)/;
const NODE_TAP_PASS = /^#\s+pass\s+(\d+)/;
const NODE_TAP_FAIL = /^#\s+fail\s+(\d+)/;
const NODE_TAP_SKIP = /^#\s+skip\s+(\d+)/;
const NODE_DURATION_TAIL = /\s+\((\d+(?:\.\d+)?)\s*(ms|s)\)\s*$/;
const NODE_SKIP_SUFFIX = /\s+#\s*(?:SKIP|TODO)\b\s*:?\s*(.*)$/i;

function nodeSpecOutcome(marker: string): AppTestOutcome | null {
  if (marker === '✔') return 'passed';
  if (marker === '✖' || marker === '✗') return 'failed';
  if (marker === '﹣' || marker === '-') return 'skipped';
  return null;
}

function scanNodeTest(lines: readonly string[], collector: Collector): void {
  if (/^TAP version \d+/m.test(lines.slice(0, 3).join('\n'))) collector.sawStructure = true;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    if (raw.trim() === '') continue;
    const line = raw.length > MAX_SCAN_LINE_CHARS ? raw.slice(0, MAX_SCAN_LINE_CHARS) : raw;

    const specTests = NODE_SPEC_TESTS.exec(line);
    const specPass = NODE_SPEC_PASS.exec(line);
    const specFail = NODE_SPEC_FAIL.exec(line);
    const specSkip = NODE_SPEC_SKIP.exec(line);
    if (specTests !== null || specPass !== null || specFail !== null || specSkip !== null) {
      collector.sawStructure = true;
      if (specTests !== null) collector.summary.total = Number(specTests[1]);
      if (specPass !== null) collector.summary.passed = Number(specPass[1]);
      if (specFail !== null) collector.summary.failed = Number(specFail[1]);
      if (specSkip !== null) collector.summary.skipped = Number(specSkip[1]);
      continue;
    }

    const tapTests = NODE_TAP_TESTS.exec(line);
    const tapPass = NODE_TAP_PASS.exec(line);
    const tapFail = NODE_TAP_FAIL.exec(line);
    const tapSkip = NODE_TAP_SKIP.exec(line);
    if (tapTests !== null || tapPass !== null || tapFail !== null || tapSkip !== null) {
      collector.sawStructure = true;
      if (tapTests !== null) collector.summary.total = Number(tapTests[1]);
      if (tapPass !== null) collector.summary.passed = Number(tapPass[1]);
      if (tapFail !== null) collector.summary.failed = Number(tapFail[1]);
      if (tapSkip !== null) collector.summary.skipped = Number(tapSkip[1]);
      continue;
    }

    if (NODE_TAP_PLAN.test(line)) {
      collector.sawStructure = true;
      const plan = NODE_TAP_PLAN.exec(line);
      if (plan !== null) collector.summary.total = Number(plan[1]);
      continue;
    }

    const tapResult = NODE_TAP_RESULT.exec(line);
    if (tapResult !== null) {
      collector.sawStructure = true;
      const passed = tapResult[2] === 'ok';
      const rawTitle = (tapResult[4] ?? '').trim();
      const skip = NODE_SKIP_SUFFIX.exec(` ${rawTitle}`);
      const title = boundTitle(rawTitle.replace(NODE_SKIP_SUFFIX, '').trim());
      if (title === '') continue;
      const baseIndent = (tapResult[1] ?? '').length;
      const captured = passed
        ? { detailLines: [], next: index + 1 }
        : captureDetail(
            lines,
            index + 1,
            (next, _sawBlank) => next.trim() !== '' && leadingSpaces(next) <= baseIndent,
          );
      if (!passed) {
        addFailure(collector, title, null, cleanTapDetail(captured.detailLines));
      }
      const order = collector.nextOrder++;
      if (skip !== null) {
        const reason = (skip[1] ?? '').trim();
        addDraft(collector, order, {
          title,
          outcome: 'skipped',
          durationMs: null,
          skipReason: reason === '' ? null : boundTitle(reason),
          error: null,
          file: null,
        });
      } else {
        addDraft(collector, order, {
          title,
          outcome: passed ? 'passed' : 'failed',
          durationMs: null,
          skipReason: null,
          error: null,
          file: null,
        });
      }
      index = captured.next - 1;
      continue;
    }

    if (/^\s*[✖✗×]\s*failing tests:\s*$/i.test(line)) {
      collector.sawStructure = true;
      continue;
    }

    const specResult = NODE_SPEC_RESULT.exec(line);
    if (specResult !== null) {
      const marker = specResult[2] ?? '';
      const outcome = nodeSpecOutcome(marker);
      if (outcome === null) continue;
      const payload = (specResult[3] ?? '').trim();
      if (payload === '') continue;
      // Suite footers (`✖ suite name (12.3ms)`) are groups, not tests.
      if (/^\(\d+(?:\.\d+)?\s*m?s\)$/.test(payload)) continue;
      const baseIndent = (specResult[1] ?? '').length;
      const skip = NODE_SKIP_SUFFIX.exec(` ${payload}`);
      const withoutSkip = payload.replace(NODE_SKIP_SUFFIX, '').trim();
      const { title, durationMs } = splitDuration(withoutSkip, NODE_DURATION_TAIL);
      const bounded = boundTitle(title);
      if (bounded === '') continue;
      collector.sawStructure = true;
      const captured =
        outcome === 'failed'
          ? captureDetail(
              lines,
              index + 1,
              (next) => next.trim() !== '' && leadingSpaces(next) <= baseIndent,
            )
          : { detailLines: [], next: index + 1 };
      if (outcome === 'failed') {
        addFailure(collector, bounded, null, captured.detailLines);
      }
      const order = collector.nextOrder++;
      if (skip !== null) {
        const reason = (skip[1] ?? '').trim();
        addDraft(collector, order, {
          title: bounded,
          outcome: 'skipped',
          durationMs,
          skipReason: reason === '' ? null : boundTitle(reason),
          error: null,
          file: null,
        });
      } else {
        addDraft(collector, order, {
          title: bounded,
          outcome,
          durationMs,
          skipReason: null,
          error: null,
          file: null,
        });
      }
      index = captured.next - 1;
      continue;
    }
  }
}

// ---------------------------------------------------------------------------
// Mocha
// ---------------------------------------------------------------------------

const MOCHA_RESULT_LINE = /^(\s{1,10})([✓✔✗✖×])\s{1,3}(\S.*)$/;
const MOCHA_PENDING_LINE = /^(\s{1,10})[-–]\s{1,3}(\S.*)$/;
const MOCHA_NUMBERED = /^\s{0,6}(\d+)\)\s*(.*)$/;
const MOCHA_SUMMARY = /^\s{0,4}(\d+)\s+(passing|failing|pending)\b(.*)$/;
const MOCHA_DURATION_TAIL = /\s+\((\d+(?:\.\d+)?)\s*(ms|s)\)\s*$/;

function mochaOutcome(marker: string): AppTestOutcome | null {
  if (marker === '✓' || marker === '✔') return 'passed';
  if (marker === '✗' || marker === '✖' || marker === '×') return 'failed';
  return null;
}

function isMochaDetailTerminator(line: string, _sawBlank: boolean): boolean {
  if (/^\s{0,3}\d+\)\s/.test(line)) return true;
  if (MOCHA_SUMMARY.test(line)) return true;
  if (/^\s*(npm ERR!|ELIFECYCLE|error Command failed)/.test(line)) return true;
  return false;
}

function scanMocha(lines: readonly string[], collector: Collector): void {
  let afterSummary = false;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    if (raw.trim() === '') continue;
    const line = raw.length > MAX_SCAN_LINE_CHARS ? raw.slice(0, MAX_SCAN_LINE_CHARS) : raw;

    const summary = MOCHA_SUMMARY.exec(line);
    if (summary !== null) {
      collector.sawStructure = true;
      const value = Number(summary[1] ?? '0');
      const word = summary[2] ?? '';
      if (word === 'passing') collector.summary.passed = value;
      if (word === 'failing') collector.summary.failed = value;
      if (word === 'pending') collector.summary.skipped = value;
      if (word === 'failing' || word === 'passing') afterSummary = true;
      continue;
    }

    const numbered = MOCHA_NUMBERED.exec(line);
    if (numbered !== null) {
      collector.sawStructure = true;
      if (afterSummary) {
        const suite = (numbered[2] ?? '').trim();
        const captured = captureDetail(lines, index + 1, isMochaDetailTerminator);
        const cleaned = captured.detailLines.map((detail) => detail.replace(/\s+$/, ''));
        let name: string | null = null;
        let consumed = 0;
        for (let cursor = 0; cursor < cleaned.length; cursor += 1) {
          const candidate = cleaned[cursor] ?? '';
          if (candidate.trim() === '') continue;
          consumed = cursor + 1;
          if (candidate.trim().endsWith(':')) {
            name = candidate.trim().slice(0, -1).trim();
          }
          break;
        }
        const title = name !== null ? `${suite} \u203a ${name}` : suite;
        addFailure(collector, title, null, cleaned.slice(consumed));
        index = captured.next - 1;
        continue;
      }
      const title = boundTitle(numbered[2] ?? '');
      if (title === '') continue;
      const order = collector.nextOrder++;
      addDraft(collector, order, {
        title,
        outcome: 'failed',
        durationMs: null,
        skipReason: null,
        error: null,
        file: null,
      });
      continue;
    }

    const pending = MOCHA_PENDING_LINE.exec(line);
    if (pending !== null) {
      const { title, durationMs } = splitDuration((pending[2] ?? '').trim(), MOCHA_DURATION_TAIL);
      const bounded = boundTitle(title);
      if (bounded === '') continue;
      collector.sawStructure = true;
      const order = collector.nextOrder++;
      addDraft(collector, order, {
        title: bounded,
        outcome: 'skipped',
        durationMs,
        skipReason: null,
        error: null,
        file: null,
      });
      continue;
    }

    const result = MOCHA_RESULT_LINE.exec(line);
    if (result !== null) {
      const outcome = mochaOutcome(result[2] ?? '');
      if (outcome === null) continue;
      const { title, durationMs } = splitDuration((result[3] ?? '').trim(), MOCHA_DURATION_TAIL);
      const bounded = boundTitle(title);
      if (bounded === '') continue;
      collector.sawStructure = true;
      const order = collector.nextOrder++;
      addDraft(collector, order, {
        title: bounded,
        outcome,
        durationMs,
        skipReason: null,
        error: null,
        file: null,
      });
      continue;
    }
  }
}

// ---------------------------------------------------------------------------
// Failure attachment
// ---------------------------------------------------------------------------

function pickTarget(
  candidates: readonly DraftTest[],
  failure: DraftFailure,
): DraftTest | undefined {
  if (candidates.length === 0) return undefined;
  const wantedTitle = normaliseTitle(failure.title);
  const exact = candidates.filter((draft) => normaliseTitle(draft.title) === wantedTitle);
  if (exact.length === 1) return exact[0];

  const wantedLast = lastSegment(failure.title);
  if (wantedLast !== '') {
    const byLast = candidates.filter((draft) => lastSegment(draft.title) === wantedLast);
    if (byLast.length === 1) return byLast[0];
  }

  if (failure.file !== null) {
    const byFile = candidates.filter((draft) => draft.file === failure.file);
    if (byFile.length >= 1) return byFile[0];
  }

  if (candidates.length === 1) return candidates[0];
  return undefined;
}

/**
 * Attaches each failure block's detail to the failed test it belongs to.
 * A failure block that matches nothing becomes its own failed result — it is a
 * real reporter line, not an invented test — and is counted so the note can say
 * so.
 */
function attachFailures(collector: Collector): number {
  let created = 0;
  for (const failure of collector.failures) {
    const error = buildError(failure.detailLines);
    const failedDrafts = collector.drafts.filter((draft) => draft.outcome === 'failed');
    const withoutError = failedDrafts.filter((draft) => draft.error === null);
    const target = pickTarget(withoutError, failure);
    if (target !== undefined) {
      target.error = error;
      continue;
    }
    const already = pickTarget(failedDrafts, failure);
    if (already !== undefined) {
      if (already.error === null) already.error = error;
      continue;
    }
    created += 1;
    collector.syntheticCount += 1;
    addDraft(collector, collector.nextOrder++, {
      title: boundTitle(failure.title) || 'unnamed failing test',
      outcome: 'failed',
      durationMs: null,
      skipReason: null,
      error,
      file: failure.file,
    });
  }
  return created;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function unreachableNote(runner: TestRunner): string {
  if (runner === 'none') return 'No test runner was identified, so the output was not parsed.';
  return `The output did not contain recognisable ${RUNNER_LABEL[runner]} result lines, so no tests could be read.`;
}

function finalise(runner: TestRunner, collector: Collector, truncated: boolean): ParsedTestOutput {
  if (!collector.sawStructure) {
    return { tests: [], recognised: false, truncated, note: unreachableNote(runner) };
  }
  if (runner === 'none') {
    return { tests: [], recognised: false, truncated, note: unreachableNote('none') };
  }

  const created = attachFailures(collector);
  const ordered = [...collector.drafts].sort((a, b) => a.order - b.order).slice(0, MAX_TESTS);

  const tests: AppTestResult[] = ordered.map((draft, index) => ({
    id: `t-${index + 1}`,
    kind: 'unit',
    title: draft.title === '' ? 'unnamed test' : draft.title,
    outcome: draft.outcome,
    skipReason: draft.outcome === 'skipped' ? (draft.skipReason ?? DEFAULT_SKIP_REASON) : null,
    error: draft.outcome === 'failed' ? draft.error : null,
    durationMs: draft.durationMs,
  }));

  const parts: string[] = [];
  const label = RUNNER_LABEL[runner];
  if (tests.length === 0) {
    parts.push(`The ${label} output was recognised but listed no individual test results.`);
  } else {
    parts.push(
      `Parsed ${collector.parsedCount} test${collector.parsedCount === 1 ? '' : 's'} from ${label} output.`,
    );
  }

  if (truncated) {
    parts.push(
      `The output was larger than ${Math.floor(MAX_OUTPUT_CHARS / 1024)} KB, so only the first ${Math.floor(MAX_OUTPUT_CHARS / 1024)} KB was read.`,
    );
  }

  if (collector.parsedCount > MAX_TESTS) {
    parts.push(
      `Only the first ${MAX_TESTS} of ${collector.parsedCount} parsed tests are reported.`,
    );
  }

  if (collector.fileLevelOnly > 0) {
    parts.push(
      `${collector.fileLevelOnly} file-level result${collector.fileLevelOnly === 1 ? '' : 's'} had no individual test names in the output.`,
    );
  }

  if (created > 0) {
    parts.push(
      `${created} failure block${created === 1 ? '' : 's'} had no matching test line and ${created === 1 ? 'is' : 'are'} included as ${created === 1 ? 'a' : 'their own'} result.`,
    );
  }

  const summary = collector.summary;
  const summed =
    summary.passed !== null || summary.failed !== null || summary.skipped !== null
      ? (summary.passed ?? 0) + (summary.failed ?? 0) + (summary.skipped ?? 0)
      : null;
  const reportedTotal = summary.total ?? summed;
  if (reportedTotal !== null && reportedTotal !== collector.parsedCount) {
    const parsedWord = collector.parsedCount === 1 ? 'test' : 'tests';
    parts.push(
      `Parsed ${collector.parsedCount} ${parsedWord} but the summary reports ${reportedTotal}.`,
    );
  }

  return {
    tests,
    recognised: true,
    truncated,
    note: parts.join(' '),
  };
}

/**
 * Parses captured test-run output into per-test results.
 *
 * Never throws: unreadable input is reported through `recognised: false`.
 */
export function parseTestOutput(runner: TestRunner, output: string): ParsedTestOutput {
  if (runner === 'none') {
    return {
      tests: [],
      recognised: false,
      truncated: false,
      note: unreachableNote('none'),
    };
  }
  if (typeof output !== 'string' || output.trim() === '') {
    return {
      tests: [],
      recognised: false,
      truncated: false,
      note: `The ${RUNNER_LABEL[runner]} output was empty, so there were no results to read.`,
    };
  }

  let text = stripAnsi(output);
  let truncated = false;
  if (text.length > MAX_OUTPUT_CHARS) {
    truncated = true;
    const cut = text.slice(0, MAX_OUTPUT_CHARS);
    const lastNewline = cut.lastIndexOf('\n');
    text = lastNewline > 0 ? cut.slice(0, lastNewline) : cut;
  }

  const lines = toLines(text);
  const collector = createCollector();
  switch (runner) {
    case 'vitest':
      scanVitest(lines, collector);
      break;
    case 'jest':
      scanJest(lines, collector);
      break;
    case 'node-test':
      scanNodeTest(lines, collector);
      break;
    case 'mocha':
      scanMocha(lines, collector);
      break;
  }

  return finalise(runner, collector, truncated);
}
