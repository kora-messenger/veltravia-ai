import type { BackendReport } from '../backend/index.js';

import type { AppHealth, StatusFact } from './types.js';

/**
 * Application health (Step 34).
 *
 * The panel reports what was SEEN, never what was hoped for. The four words the
 * brief asks to distinguish are separate statuses:
 *
 * - `detected`      files of this layer were found and read
 * - `configured`    a declaration exists (a database provider, a manifest)
 * - `tested`        a test run was recorded (never claimed in this release)
 * - `running`       a live runtime/process exists (only from a real runtime)
 *
 * `unavailable` means the information exists in principle but is not connected,
 * and `not-configured` means the project does not have it. Configuration alone
 * never contributes to a "working" claim.
 */

export interface HealthInput {
  /** Files the frontend classifier placed, and whether it recognised a layout. */
  readonly frontendFiles: number;
  readonly frontendLayout: string;
  readonly frontendFramework: string | null;
  readonly backend: BackendReport;
  /**
   * Backend SOURCE files, from the same grouping the explorer uses. The scan
   * also reads manifests, which are configuration rather than backend source;
   * without this the panel would report backend files for a project that has
   * none.
   */
  readonly backendFiles?: number;
  /** Configuration files found by the grouping pass. */
  readonly configurationFiles: number;
  readonly testFiles: number;
  /** Runtime state observed by the server, never assumed. */
  readonly runtime: 'running' | 'stopped' | 'none';
  readonly unmatchedRequests: number;
  /** True when a scan hit its file cap, so the picture is partial. */
  readonly scanCapped: boolean;
}

const FACT_LABELS: Record<StatusFact['status'], string> = {
  configured: 'Configured',
  detected: 'Detected',
  tested: 'Tested',
  running: 'Running',
  unavailable: 'Unavailable',
  'not-configured': 'Not configured',
};

function fact(
  status: StatusFact['status'],
  detail: string,
  evidence: readonly string[] = [],
): StatusFact {
  return { status, label: FACT_LABELS[status], detail, evidence: evidence.slice(0, 5) };
}

export function buildAppHealth(input: HealthInput): AppHealth {
  const { backend } = input;

  const frontend =
    input.frontendFiles === 0
      ? fact('not-configured', 'No frontend source files were found in this workspace.')
      : fact(
          'detected',
          `${input.frontendFiles} frontend file(s) classified as a ${input.frontendLayout} layout${
            input.frontendFramework === null ? '' : ` (${input.frontendFramework})`
          }. Nothing here has been built or run.`,
        );

  const backendSourceFiles = input.backendFiles ?? backend.structure.totals.files;
  const backendFact =
    backendSourceFiles === 0 && backend.routes.length === 0 && backend.models.length === 0
      ? fact('not-configured', 'No backend source files, routes or models were found.')
      : fact(
          'detected',
          `${backend.routes.length} route(s) and ${backend.models.length} model(s) were read from ${backendSourceFiles} backend file(s). Analysis only: no server was started.`,
        );

  const apiRoutes =
    backend.routes.length === 0
      ? fact('not-configured', 'No route declarations were recognised in the files that were read.')
      : fact(
          'detected',
          `${backend.routes.length} route declaration(s) recognised across ${
            new Set(backend.routes.map((route) => route.file)).size
          } file(s).`,
        );

  const database =
    backend.database.status === 'declared'
      ? fact(
          'configured',
          `A database provider is declared (${backend.database.provider ?? 'unnamed'}) with ${backend.database.models} model(s). No connection is opened in this release.`,
          backend.database.evidence,
        )
      : fact(
          'not-configured',
          'No database provider or schema was declared in the files that were read.',
        );

  const tests =
    input.testFiles === 0
      ? fact('not-configured', 'No test files were found in this workspace.')
      : fact(
          'detected',
          `${input.testFiles} test file(s) found. No test run is recorded, so they are not reported as tested or passing.`,
        );

  const runtime =
    input.runtime === 'running'
      ? fact('running', 'A runtime for this workspace is running (simulated executor).')
      : input.runtime === 'stopped'
        ? fact('unavailable', 'A runtime exists for this workspace but is stopped.')
        : fact('unavailable', 'No runtime has been started for this workspace.');

  const warnings: string[] = [];
  const errors: string[] = [];

  if (input.unmatchedRequests > 0) {
    warnings.push(
      `${input.unmatchedRequests} frontend request(s) have no matching backend route in the files that were read.`,
    );
  }
  if (backend.database.status === 'declared' && backend.database.connection === 'not-configured') {
    warnings.push('A database is declared but no connection is configured in this release.');
  }
  if (backend.auth.status === 'absent' && backend.routes.length > 0) {
    warnings.push('Routes were found but no authentication library is declared.');
  }
  if (apiRoutes.status === 'not-configured' && backendSourceFiles > 0) {
    warnings.push('Backend files exist but no route declaration was recognised.');
  }
  if (backend.warnings.length > 0) {
    warnings.push(...backend.warnings.slice(0, 5).map((warning) => `Backend scan: ${warning}`));
  }
  if (backend.scanned.truncated) {
    warnings.push('At least one file was truncated while reading, so its analysis is partial.');
  }
  if (input.scanCapped) {
    warnings.push('The scan stopped at its file cap; other files were not read.');
  }

  return {
    frontend,
    backend: backendFact,
    apiRoutes,
    database,
    tests,
    runtime,
    errors,
    warnings,
    inspectedCompletely: !input.scanCapped && !backend.scanned.truncated,
  };
}
