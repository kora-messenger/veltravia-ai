import { useEffect, useState } from 'react';

import { Badge, Button, EmptyState, ErrorState, Spinner } from '../../components/ui';
import { errorMessage } from '../../api/client';
import * as projectsApi from '../../api/projects';
import * as workspacesApi from '../../api/workspaces';
import { navigateToHash } from '../../shell/useHashRoute';
import { ApprovalCard, BugList, FoundPanel, StatusSummary, TestList } from './TestingSections';
import { useTestingRun } from './useTestingRun';
import { canCancel, primaryAction, stateLabel, statusLabel, statusTone } from './view-model';
import './testing.css';

/**
 * Application testing for one project.
 *
 * It sits inside the project workspace next to the builders, over the same
 * testing run the API owns. Three regions on a wide screen (what was found,
 * results, problems and decisions), two on a tablet, and switchable panels on a
 * phone. The page decides nothing about a result: it shows the report, and every
 * approval it offers goes to a person.
 */

interface TestingPageProps {
  readonly projectId: string | null;
}

type MobilePanel = 'found' | 'results' | 'problems';

export function TestingPage({ projectId }: TestingPageProps) {
  const [project, setProject] = useState<projectsApi.ProjectView | null>(null);
  const [workspace, setWorkspace] = useState<workspacesApi.WorkspaceView | null>(null);
  const [contextError, setContextError] = useState('');
  const [contextLoading, setContextLoading] = useState(true);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('results');
  const [selectedTest, setSelectedTest] = useState<string | null>(null);
  const run = useTestingRun();

  useEffect(() => {
    if (projectId === null) {
      setContextError('No project was selected.');
      setContextLoading(false);
      return;
    }
    let cancelled = false;
    setContextLoading(true);
    setContextError('');
    void (async () => {
      try {
        const [nextProject, nextWorkspaces] = await Promise.all([
          projectsApi.getProject(projectId),
          workspacesApi.listWorkspaces(projectId),
        ]);
        if (cancelled) return;
        setProject(nextProject);
        const active = nextWorkspaces.find((entry) => entry.status === 'active');
        setWorkspace(active ?? nextWorkspaces[0] ?? null);
      } catch (loadError) {
        if (!cancelled) setContextError(errorMessage(loadError));
      } finally {
        if (!cancelled) setContextLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (contextLoading) {
    return (
      <div className="v-testing v-testing--loading" data-testid="testing-page">
        <p className="v-testing__note" role="status">
          <Spinner size="sm" aria-label="Loading project" /> Loading project…
        </p>
      </div>
    );
  }
  if (contextError !== '' || project === null) {
    return (
      <div className="v-testing" data-testid="testing-page">
        <ErrorState
          title="Could not open this project"
          description={contextError || 'The project could not be found.'}
          retry={{ label: 'Back to projects', onClick: () => navigateToHash('#/projects') }}
        />
      </div>
    );
  }
  if (workspace === null) {
    return (
      <div className="v-testing" data-testid="testing-page">
        <EmptyState
          title="No workspace yet"
          description="A project needs a workspace before it can be tested. Create one from the project page."
          action={{
            label: 'Open the project',
            onClick: () => navigateToHash(`#/projects/${project.id}`),
          }}
        />
      </div>
    );
  }

  const action = primaryAction(run.status);
  const working = run.busy || (run.status !== null && action === 'cancel');
  const begin = () => {
    setSelectedTest(null);
    void run.start({ projectId: project.id, workspaceId: workspace.id });
  };

  return (
    <div className={`v-testing v-testing--panel-${mobilePanel}`} data-testid="testing-page">
      <header className="v-testing__header">
        <div className="v-testing__identity">
          <h1 className="v-testing__title">{project.name}</h1>
          <div className="v-testing__badges">
            <Badge tone="primary">Application testing</Badge>
            {run.status !== null && (
              <Badge tone="neutral" data-testid="testing-state">
                {stateLabel(run.status.state)}
              </Badge>
            )}
            {run.report !== null && (
              <Badge tone={statusTone(run.report.status)}>{statusLabel(run.report.status)}</Badge>
            )}
          </div>
        </div>
        <div className="v-testing__header-actions">
          {action === 'start' && (
            <Button onClick={begin} loading={run.busy} data-testid="testing-start">
              Start testing
            </Button>
          )}
          {action === 'rerun' && (
            <Button onClick={begin} loading={run.busy} data-testid="testing-rerun">
              Rerun tests
            </Button>
          )}
          {canCancel(run.status) && (
            <Button
              variant="secondary"
              onClick={() => void run.cancel()}
              disabled={run.busy}
              data-testid="testing-cancel"
            >
              Cancel run
            </Button>
          )}
        </div>
      </header>

      {run.error !== '' && (
        <div className="v-testing__alert" role="alert" data-testid="testing-error">
          {run.error}
        </div>
      )}

      <div className="v-testing__tabs" role="tablist" aria-label="Testing sections">
        {(
          [
            ['found', 'Found'],
            ['results', 'Results'],
            ['problems', 'Problems'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={mobilePanel === id}
            className={`v-testing__tab${mobilePanel === id ? ' v-testing__tab--active' : ''}`}
            onClick={() => setMobilePanel(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {run.started === null && !run.busy ? (
        <EmptyState
          title="Test this application"
          description="The agent reads your project, works out what it does, proposes tests and checks for security problems. Nothing runs until you approve the plan, and nothing in your project changes without your approval."
          action={{ label: 'Start testing', onClick: begin }}
        />
      ) : (
        <div className="v-testing__body">
          <div className="v-testing__region v-testing__region--found">
            {run.started !== null && (
              <FoundPanel
                inspection={run.started.inspection}
                proposed={run.started.proposedTests}
                skipped={run.started.skippedKinds}
              />
            )}
          </div>
          <div className="v-testing__region v-testing__region--results">
            {working && run.report === null && (
              <p className="v-testing__note" role="status" data-testid="testing-working">
                <Spinner size="sm" aria-label="Working" /> Working…
              </p>
            )}
            <ApprovalCard
              pending={run.status?.pendingApproval ?? null}
              busy={run.busy}
              onDecide={(decision) => void run.decide(decision)}
            />
            {run.report !== null && (
              <>
                <StatusSummary report={run.report} />
                <TestList
                  report={run.report}
                  selectedId={selectedTest}
                  onSelect={setSelectedTest}
                />
              </>
            )}
          </div>
          <div className="v-testing__region v-testing__region--problems">
            {run.report !== null && <BugList bugs={run.report.bugs} />}
          </div>
        </div>
      )}
    </div>
  );
}
