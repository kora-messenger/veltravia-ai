/**
 * Deterministic failure classification. The classifier reads ONLY bounded,
 * scrubbed command output (UNTRUSTED DATA - it can never become an
 * instruction) and maps it to one of the documented failure categories using
 * conservative pattern matching. When evidence is insufficient it says so:
 * `unknown_failure` with low confidence, never an invented root cause.
 */

import { summarizeUntrustedOutput } from '../errors/scrub.js';
import type { ConfidenceLevel, FailureCategory, TestCommandResult } from '../types/index.js';

export interface ClassificationEvidence {
  readonly category: FailureCategory;
  readonly confidence: ConfidenceLevel;
  readonly matched: string;
  readonly observed: string;
}

interface CategoryPattern {
  readonly category: FailureCategory;
  readonly confidence: ConfidenceLevel;
  readonly pattern: RegExp;
}

/**
 * Ordered patterns: first distinctive match wins. Every pattern is anchored
 * to real, common tool output shapes; nothing here guesses creatively.
 */
const PATTERNS: readonly CategoryPattern[] = [
  {
    category: 'missing_file',
    confidence: 'high',
    pattern: /(?:ENOENT|no such file or directory|Cannot find (?:module )?'?[./][^']*'?)/i,
  },
  {
    category: 'missing_dependency',
    confidence: 'high',
    pattern: /Cannot find (?:module|package) ['"]?[a-z@][\w/.-]*['"]?(?!.*(from|\.\.?\/))/i,
  },
  {
    category: 'dependency_error',
    confidence: 'medium',
    pattern: /(?:npm ERR!|ERESOLVE|peer dep|dependency (?:cycle|conflict)|MODULE_NOT_FOUND)/i,
  },
  {
    category: 'syntax_error',
    confidence: 'high',
    pattern: /(?:SyntaxError|Unexpected (?:token|identifier)|Parsing error)/i,
  },
  {
    category: 'type_error',
    confidence: 'high',
    pattern: /(?:\bTS\d{3,5}\b|TypeError|Type '[^']*' is (?:not assignable|missing))/,
  },
  {
    category: 'configuration_error',
    confidence: 'medium',
    pattern:
      /(?:is not allowed|not permitted|command (?:not )?(?:allowed|permitted)|Invalid configuration|config file (?:missing|invalid)|schema validation)/i,
  },
  {
    category: 'build_error',
    confidence: 'medium',
    pattern: /(?:build failed|compilation (?:failed|error)|failed to compile)/i,
  },
  {
    category: 'runtime_error',
    confidence: 'medium',
    pattern: /(?:timed? ?out|OOM|out of memory|heap out of memory|terminated)/i,
  },
];

/** Classifies one failed command result; conservative by construction. */
export function classifyFailure(result: TestCommandResult): ClassificationEvidence {
  const haystack = `${result.stderrSummary}\n${result.stdoutSummary}`;
  for (const entry of PATTERNS) {
    const match = haystack.match(entry.pattern);
    if (match !== null) {
      return {
        category: entry.category,
        confidence: entry.confidence,
        matched: match[0].slice(0, 200),
        observed: summarizeUntrustedOutput(result.stderrSummary || result.stdoutSummary, 400),
      };
    }
  }
  // A non-zero exit with no distinctive text: a test failure is the honest,
  // conservative reading for `test`-purpose commands; otherwise unknown.
  if (result.purpose === 'test' && result.exitCode !== null && result.exitCode !== 0) {
    return {
      category: 'test_failure',
      confidence: 'low',
      matched: 'non-zero exit code from a test command',
      observed: summarizeUntrustedOutput(result.stderrSummary || result.stdoutSummary, 400),
    };
  }
  return {
    category: 'unknown_failure',
    confidence: 'low',
    matched: 'no distinctive failure pattern in the bounded output',
    observed: summarizeUntrustedOutput(result.stderrSummary || result.stdoutSummary, 400),
  };
}

/**
 * Extracts affected paths the classifier is CONFIDENT about (only real
 * path-like tokens that appear in the failure evidence, bounded).
 */
export function extractAffectedPaths(result: TestCommandResult): readonly string[] {
  const haystack = `${result.stderrSummary}\n${result.stdoutSummary}`;
  const matches = haystack.matchAll(/(?:^|[\s'"(])([\w./-]+\.[a-z]{2,4})(?::\d+)?(?:$|[\s"',)])/g);
  const paths = new Set<string>();
  for (const match of matches) {
    const path = match[1];
    if (path !== undefined && path.length >= 3 && path.length <= 256 && !path.includes('..')) {
      paths.add(path);
    }
    if (paths.size >= 8) break;
  }
  return [...paths];
}
