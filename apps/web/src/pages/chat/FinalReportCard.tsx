import type { FinalAgentReport, ValidationOutcome } from '@veltravia/shared';

/**
 * The statement that closes a run.
 *
 * It repeats nothing the timeline already shows: the timeline is the record of
 * what happened, this is the answer to "so what did it actually do". Each line
 * is conditional on the server having reported it, so an empty section is left
 * out rather than filled with a reassuring zero.
 */

const STATUS_COPY: Record<string, { readonly label: string; readonly tone: string }> = {
  completed: { label: 'Completed', tone: 'done' },
  completed_with_warnings: { label: 'Completed with warnings', tone: 'warn' },
  partially_completed: { label: 'Partially completed', tone: 'warn' },
  failed: { label: 'Failed', tone: 'failed' },
  cancelled: { label: 'Cancelled', tone: 'stopped' },
};

const VALIDATION_LABEL: Record<string, string> = {
  tests: 'Tests',
  lint: 'Lint',
  types: 'Type check',
  build: 'Build',
};

function outcomeWord(outcome: ValidationOutcome): string {
  if (outcome === 'passed') return 'passed';
  if (outcome === 'failed') return 'failed';
  return 'did not run';
}

export function FinalReportCard({ report }: { readonly report: FinalAgentReport }) {
  const status = STATUS_COPY[report.status] ?? { label: 'Finished', tone: 'done' };
  const files = report.filesChanged;
  const changed: { readonly label: string; readonly paths: readonly string[] }[] = [
    { label: 'Created', paths: files.created },
    { label: 'Updated', paths: files.updated },
    { label: 'Deleted', paths: files.deleted },
  ];
  const hasFiles = changed.some((entry) => entry.paths.length > 0);
  const checks = Object.entries(report.validation).filter(([, outcome]) => outcome !== 'not_run');

  return (
    <section className={`v-report is-${status.tone}`} aria-label="Run report">
      <header className="v-report__head">
        <span className="v-report__status">{status.label}</span>
        <p className="v-report__summary">{report.summary}</p>
      </header>

      {report.completed.length > 0 ? (
        <div className="v-report__section">
          <h3>What was done</h3>
          <ul>
            {report.completed.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {hasFiles ? (
        <div className="v-report__section">
          <h3>Files changed</h3>
          {changed
            .filter((entry) => entry.paths.length > 0)
            .map((entry) => (
              <p className="v-report__files" key={entry.label}>
                <span>{entry.label}</span> {entry.paths.join(', ')}
              </p>
            ))}
        </div>
      ) : null}

      {checks.length > 0 ? (
        <div className="v-report__section">
          <h3>Checks</h3>
          <ul className="v-report__checks">
            {checks.map(([key, outcome]) => (
              <li key={key} className={outcome === 'failed' ? 'is-failed' : ''}>
                {VALIDATION_LABEL[key] ?? key}: {outcomeWord(outcome)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {report.failures.length > 0 ? (
        <div className="v-report__section">
          <h3>What failed</h3>
          <ul>
            {report.failures.map((failure) => (
              <li key={`${failure.title}-${failure.reason}`}>
                {failure.title}: {failure.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {report.recovery.length > 0 ? (
        <div className="v-report__section">
          <h3>Recovery</h3>
          <ul>
            {report.recovery.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {report.remaining.length > 0 ? (
        <div className="v-report__section">
          <h3>Still open</h3>
          <ul>
            {report.remaining.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
