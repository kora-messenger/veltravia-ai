import { Badge, Button } from '../../components/ui';
import type {
  AppInspection,
  AppTestReport,
  Bug,
  PendingApproval,
  ProposedTest,
} from '../../api/app-testing';
import {
  approvalCopy,
  certaintyLabel,
  countsOf,
  environmentCopy,
  headline,
  severityRank,
  severityTone,
  statusLabel,
  statusTone,
} from './view-model';

/**
 * The parts of the testing page. Each one only shows what the report, the
 * inspection or the run status say; none of them decides a result.
 */

export function StatusSummary({ report }: { readonly report: AppTestReport }) {
  const counts = countsOf(report);
  return (
    <section className="v-testing__panel" aria-labelledby="testing-summary-title">
      <div className="v-testing__panel-head">
        <h2 id="testing-summary-title" className="v-testing__panel-title">
          Result
        </h2>
        <Badge tone={statusTone(report.status)} data-testid="testing-status">
          {statusLabel(report.status)}
        </Badge>
      </div>
      <p className="v-testing__headline" data-testid="testing-headline">
        {headline(report)}
      </p>
      <dl className="v-testing__counts" aria-label="Test counts">
        <div className="v-testing__count v-testing__count--passed">
          <dt>Passed</dt>
          <dd data-testid="count-passed">{counts.passed}</dd>
        </div>
        <div className="v-testing__count v-testing__count--failed">
          <dt>Failed</dt>
          <dd data-testid="count-failed">{counts.failed}</dd>
        </div>
        <div className="v-testing__count v-testing__count--skipped">
          <dt>Skipped</dt>
          <dd data-testid="count-skipped">{counts.skipped}</dd>
        </div>
      </dl>
      <p className="v-testing__environment" role="note" data-testid="testing-environment">
        {environmentCopy(report)}
      </p>
      {!report.fullyTested && report.status !== 'CANCELLED' && (
        <p className="v-testing__caveat" role="note" data-testid="testing-not-full">
          This is not a complete test of your application.
        </p>
      )}
    </section>
  );
}

const OUTCOME_LABEL = { passed: 'Passed', failed: 'Failed', skipped: 'Skipped' } as const;
const OUTCOME_TONE = { passed: 'success', failed: 'error', skipped: 'neutral' } as const;

export function TestList({
  report,
  selectedId,
  onSelect,
}: {
  readonly report: AppTestReport;
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
}) {
  if (report.tests.length === 0) {
    return (
      <section className="v-testing__panel" aria-labelledby="testing-tests-title">
        <h2 id="testing-tests-title" className="v-testing__panel-title">
          Tests
        </h2>
        <p className="v-testing__empty" data-testid="testing-no-tests">
          No tests have run yet.
        </p>
      </section>
    );
  }
  return (
    <section className="v-testing__panel" aria-labelledby="testing-tests-title">
      <h2 id="testing-tests-title" className="v-testing__panel-title">
        Tests ({report.tests.length})
      </h2>
      <ul className="v-testing__tests" data-testid="testing-test-list">
        {report.tests.map((test) => {
          const open = selectedId === test.id;
          return (
            <li key={test.id} className={`v-testing__test v-testing__test--${test.outcome}`}>
              <button
                type="button"
                className="v-testing__test-row"
                aria-expanded={open}
                onClick={() => onSelect(open ? null : test.id)}
              >
                <Badge tone={OUTCOME_TONE[test.outcome]} dot>
                  {OUTCOME_LABEL[test.outcome]}
                </Badge>
                <span className="v-testing__test-title">{test.title}</span>
              </button>
              {open && (
                <div className="v-testing__test-detail" data-testid="testing-test-detail">
                  {test.outcome === 'failed' && test.error !== null && (
                    <pre className="v-testing__error" aria-label="Error details">
                      {test.error}
                    </pre>
                  )}
                  {test.outcome === 'skipped' && test.skipReason !== null && (
                    <p>Skipped: {test.skipReason}</p>
                  )}
                  {test.outcome === 'passed' && <p>This test passed.</p>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function BugList({ bugs }: { readonly bugs: readonly Bug[] }) {
  const ordered = [...bugs].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  return (
    <section className="v-testing__panel" aria-labelledby="testing-bugs-title">
      <h2 id="testing-bugs-title" className="v-testing__panel-title">
        Problems found ({bugs.length})
      </h2>
      {bugs.length === 0 ? (
        <p className="v-testing__empty" data-testid="testing-no-bugs">
          No problems were found. This only covers what was checked.
        </p>
      ) : (
        <ul className="v-testing__bugs" data-testid="testing-bug-list">
          {ordered.map((bug) => (
            <li key={bug.id} className="v-testing__bug">
              <div className="v-testing__bug-head">
                <Badge tone={severityTone(bug.severity)}>{bug.severity}</Badge>
                <Badge tone={bug.certainty === 'confirmed' ? 'error' : 'neutral'}>
                  {certaintyLabel(bug)}
                </Badge>
                <Badge tone="neutral">{bug.category}</Badge>
              </div>
              <h3 className="v-testing__bug-title">{bug.title}</h3>
              <p>{bug.summary}</p>
              {bug.affectedFiles.length > 0 && (
                <p className="v-testing__files">Files: {bug.affectedFiles.join(', ')}</p>
              )}
              <p className="v-testing__fix">
                <strong>Suggested fix:</strong> {bug.recommendation}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function FoundPanel({
  inspection,
  proposed,
  skipped,
}: {
  readonly inspection: AppInspection;
  readonly proposed: readonly ProposedTest[];
  readonly skipped: readonly { kind: string; reason: string }[];
}) {
  const rows: readonly [string, string][] = [
    ['Frontend', inspection.frontend],
    ['Backend', inspection.backend],
    ['Test runner', inspection.testRunner],
    ['Databases', inspection.databases.join(', ') || 'none found'],
    ['API routes', String(inspection.apiRoutes.length)],
    ['Pages', String(inspection.pageRoutes.length)],
    ['Existing tests', String(inspection.existingTests.length)],
  ];
  return (
    <section className="v-testing__panel" aria-labelledby="testing-found-title">
      <h2 id="testing-found-title" className="v-testing__panel-title">
        What was found
      </h2>
      <dl className="v-testing__facts" data-testid="testing-found">
        {rows.map(([label, value]) => (
          <div key={label} className="v-testing__fact">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {inspection.truncated && (
        <p className="v-testing__caveat" role="note">
          The project was too large to read completely, so this is partial.
        </p>
      )}
      <h3 className="v-testing__sub">Proposed tests ({proposed.length})</h3>
      <p className="v-testing__hint">
        These are proposals. Nothing is written to your project until you approve it.
      </p>
      {proposed.length === 0 ? (
        <p className="v-testing__empty">No tests could be proposed from what was found.</p>
      ) : (
        <ul className="v-testing__proposed">
          {proposed.map((test) => (
            <li key={test.id}>
              <Badge tone="info">{test.kind}</Badge> {test.title}
            </li>
          ))}
        </ul>
      )}
      {skipped.length > 0 && (
        <details className="v-testing__skipped">
          <summary>Not generated ({skipped.length})</summary>
          <ul>
            {skipped.map((entry) => (
              <li key={entry.kind}>
                <strong>{entry.kind}:</strong> {entry.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

export function ApprovalCard({
  pending,
  busy,
  onDecide,
}: {
  readonly pending: PendingApproval | null;
  readonly busy: boolean;
  readonly onDecide: (decision: 'approve' | 'reject') => void;
}) {
  const copy = approvalCopy(pending);
  if (copy === null) return null;
  return (
    <section
      className="v-testing__panel v-testing__approval"
      aria-labelledby="testing-approval-title"
      data-testid="testing-approval"
    >
      <h2 id="testing-approval-title" className="v-testing__panel-title">
        {copy.title}
      </h2>
      <p>{copy.detail}</p>
      <div className="v-testing__actions">
        <Button onClick={() => onDecide('approve')} disabled={busy} loading={busy}>
          Approve
        </Button>
        <Button variant="secondary" onClick={() => onDecide('reject')} disabled={busy}>
          Reject
        </Button>
      </div>
    </section>
  );
}
