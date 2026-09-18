import { describe, expect, it } from 'vitest';

import { classifyFailure, extractAffectedPaths } from './index.js';
import type { TestCommandResult } from '../types/index.js';

function result(overrides: Partial<TestCommandResult> = {}): TestCommandResult {
  return {
    index: 0,
    label: 'runtime check',
    purpose: 'test',
    command: { executable: 'node', arguments: ['--version'] },
    executed: true,
    success: false,
    exitCode: 1,
    timedOut: false,
    terminated: false,
    stdoutSummary: '',
    stderrSummary: '',
    ...overrides,
  };
}

describe('classifyFailure', () => {
  it('classifies a missing module as a missing dependency', () => {
    const evidence = classifyFailure(result({ stderrSummary: 'Error: Cannot find module react' }));
    expect(evidence.category).toBe('missing_dependency');
    expect(evidence.confidence).toBe('high');
  });

  it('classifies ENOENT as a missing file', () => {
    const evidence = classifyFailure(
      result({ stderrSummary: 'Error: ENOENT: no such file or directory, open src/index.ts' }),
    );
    expect(evidence.category).toBe('missing_file');
  });

  it('classifies TypeScript diagnostics as type errors', () => {
    const evidence = classifyFailure(result({ stdoutSummary: 'src/app.ts(10,1): error TS2345' }));
    expect(evidence.category).toBe('type_error');
    expect(evidence.matched).toMatch(/TS2345/);
  });

  it('classifies syntax errors distinctly', () => {
    const evidence = classifyFailure(result({ stderrSummary: 'SyntaxError: Unexpected token }' }));
    expect(evidence.category).toBe('syntax_error');
  });

  it('classifies command-policy denials as configuration errors', () => {
    const evidence = classifyFailure(
      result({ stderrSummary: 'the command "sudo" is not allowed by the sandbox policy' }),
    );
    expect(evidence.category).toBe('configuration_error');
  });

  it('falls back to test_failure for a bare non-zero test exit', () => {
    const evidence = classifyFailure(
      result({ stderrSummary: 'mock: the command reported a failure' }),
    );
    expect(evidence.category).toBe('test_failure');
    expect(evidence.confidence).toBe('low');
  });

  it('says unknown when there is no distinctive evidence', () => {
    const evidence = classifyFailure(result({ purpose: 'build', exitCode: 2, stderrSummary: '' }));
    expect(evidence.category).toBe('unknown_failure');
    expect(evidence.confidence).toBe('low');
  });
});

describe('extractAffectedPaths', () => {
  it('extracts real path-like tokens from bounded output', () => {
    const paths = extractAffectedPaths(
      result({ stderrSummary: 'Error at src/app.ts:42 in file src/app.ts' }),
    );
    expect(paths).toContain('src/app.ts');
    expect(paths.length).toBeLessThanOrEqual(8);
  });

  it('rejects traversal-shaped tokens', () => {
    const paths = extractAffectedPaths(result({ stderrSummary: 'open ../../etc/passwd failed' }));
    expect(paths).not.toContain('../../etc/passwd');
  });
});
