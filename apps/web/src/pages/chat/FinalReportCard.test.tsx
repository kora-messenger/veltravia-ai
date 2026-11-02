// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { FinalAgentReport } from '@veltravia/shared';
import { FinalReportCard } from './FinalReportCard';

const base: FinalAgentReport = {
  status: 'completed',
  summary: 'Fixed the failing test.',
  completed: ['Read the failing test', 'Corrected the assertion'],
  filesChanged: { created: [], updated: ['src/chat.test.ts'], deleted: [] },
  validation: { tests: 'passed', lint: 'not_run', types: 'not_run', build: 'not_run' },
  failures: [],
  recovery: [],
  remaining: [],
  generatedAt: '2026-11-02T10:00:00.000Z',
};

afterEach(cleanup);

describe('the final report', () => {
  it('states the outcome, the files and the checks that really ran', () => {
    render(<FinalReportCard report={base} />);
    expect(screen.getByText('Completed')).toBeDefined();
    expect(screen.getByText('Fixed the failing test.')).toBeDefined();
    expect(screen.getByText('src/chat.test.ts')).toBeDefined();
    expect(screen.getByText('Tests: passed')).toBeDefined();
    // Checks that did not run are left out rather than reported as passing.
    expect(screen.queryByText(/Lint:/)).toBeNull();
  });

  it('never calls a partial run completed', () => {
    render(
      <FinalReportCard
        report={{
          ...base,
          status: 'partially_completed',
          validation: { tests: 'failed', lint: 'not_run', types: 'not_run', build: 'not_run' },
          failures: [{ title: 'Ran the test suite', reason: '2 tests still fail.' }],
          remaining: ['The second assertion is still wrong.'],
        }}
      />,
    );
    expect(screen.getByText('Partially completed')).toBeDefined();
    expect(screen.getByText('Tests: failed')).toBeDefined();
    expect(screen.getByText(/2 tests still fail/)).toBeDefined();
    expect(screen.getByText('The second assertion is still wrong.')).toBeDefined();
  });

  it('leaves out the sections it has nothing to say about', () => {
    render(
      <FinalReportCard
        report={{
          ...base,
          completed: [],
          filesChanged: { created: [], updated: [], deleted: [] },
          validation: { tests: 'not_run', lint: 'not_run', types: 'not_run', build: 'not_run' },
        }}
      />,
    );
    expect(screen.queryByText('Files changed')).toBeNull();
    expect(screen.queryByText('Checks')).toBeNull();
    expect(screen.queryByText('Still open')).toBeNull();
  });
});
