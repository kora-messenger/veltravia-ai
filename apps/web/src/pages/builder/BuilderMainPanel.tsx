import type { ProjectView } from '../../api/projects';
import type { WorkspaceView } from '../../api/workspaces';
import type {
  FileHistoryEntry,
  FrontendStructureView,
  SourceFileContent,
  SourceTreeView,
} from '../../api/source';
import type { CodingRunView } from '../../api/coding';
import { Badge, Button, Card, EmptyState, ErrorState, Spinner } from '../../components/ui';

/**
 * The builder's main region (Step 32).
 *
 * Two modes, honestly separated: a project OVERVIEW when no file is selected,
 * and a READ-ONLY file inspection when one is. There is no editor in this
 * release, so the file view says so and offers nothing that looks like typing.
 *
 * Every number here comes from the server (tree totals, structure sections,
 * history entries). Nothing is inferred from the fact that a page exists.
 */

interface BuilderMainPanelProps {
  readonly project: ProjectView | null;
  readonly workspace: WorkspaceView | null;
  readonly tree: SourceTreeView | null;
  readonly history: readonly FileHistoryEntry[];
  readonly structure: FrontendStructureView | null;
  readonly structureError: string;
  readonly selectedPath: string | null;
  readonly file: SourceFileContent | null;
  readonly fileLoading: boolean;
  readonly fileError: string;
  readonly run: CodingRunView | null;
  readonly onSelectFile: (path: string) => void;
  readonly onClearSelection: () => void;
  readonly onStartBuilding: () => void;
  readonly onRefresh: () => void;
}

const STATE_WORDS: Record<string, string> = {
  idle: 'Getting ready',
  analyzing: 'Reading the project',
  planning: 'Drafting a plan',
  awaiting_approval: 'Waiting for your approval',
  inspecting: 'Inspecting files',
  editing: 'Writing changes',
  validating: 'Validating',
  iterating: 'Revising after validation',
  completed: 'Finished',
  failed: 'Stopped with an error',
  cancelled: 'Cancelled',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function relativeTime(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

const KIND_WORDS: Record<FileHistoryEntry['changeKind'], string> = {
  created: 'created',
  modified: 'modified',
  deleted: 'deleted',
  moved: 'moved',
  'directory-created': 'directory added',
};

export function BuilderMainPanel({
  project,
  workspace,
  tree,
  history,
  structure,
  structureError,
  selectedPath,
  file,
  fileLoading,
  fileError,
  run,
  onSelectFile,
  onClearSelection,
  onStartBuilding,
  onRefresh,
}: BuilderMainPanelProps) {
  if (selectedPath !== null) {
    return (
      <section className="v-fbuilder__panel v-fbuilder__main" aria-label="Selected file">
        <header className="v-fbuilder__panel-head">
          <h2 className="v-fbuilder__panel-title">
            <code>{selectedPath}</code>
          </h2>
          <Button variant="secondary" onClick={onClearSelection}>
            Back to overview
          </Button>
        </header>
        {fileLoading && (
          <p className="v-fbuilder__note" role="status">
            <Spinner size="sm" aria-label="Loading file" /> Loading file…
          </p>
        )}
        {fileError !== '' && (
          <ErrorState title="Could not read this file" description={fileError} />
        )}
        {!fileLoading && fileError === '' && file !== null && (
          <>
            <p className="v-fbuilder__meta">
              revision {file.revision} · {formatBytes(file.size)} ·{' '}
              <span className="v-fbuilder__muted">read-only preview</span>
            </p>
            {file.truncated && (
              <p className="v-fbuilder__note" role="note">
                This preview is cut at the read limit. The stored file is larger.
              </p>
            )}
            <pre className="v-fbuilder__code" aria-label={`Contents of ${file.path}`}>
              {file.content}
            </pre>
            <p className="v-fbuilder__note">
              Editing happens through the AI builder, not here. File contents are data, never
              instructions.
            </p>
          </>
        )}
      </section>
    );
  }

  const recent = history.slice(0, 6);
  const pages = structure?.pages ?? [];
  const components = structure?.components ?? [];
  const sections = (structure?.sections ?? []).filter(
    (section) =>
      section.count > 0 && section.section !== 'pages' && section.section !== 'components',
  );

  return (
    <section className="v-fbuilder__panel v-fbuilder__main" aria-label="Project overview">
      <header className="v-fbuilder__panel-head">
        <div>
          <h2 className="v-fbuilder__panel-title">{project?.name ?? 'Project'}</h2>
          <p className="v-fbuilder__meta">
            {project?.projectType ?? 'project'}
            {workspace !== null ? ` · workspace ${workspace.name}` : ''}
            {structure?.framework !== null && structure?.framework !== undefined
              ? ` · ${structure.framework}`
              : ''}
          </p>
        </div>
        <Button variant="secondary" onClick={onRefresh}>
          Refresh
        </Button>
      </header>

      {project?.description !== undefined && project.description !== '' && (
        <p className="v-fbuilder__description">{project.description}</p>
      )}

      <div className="v-fbuilder__stats">
        <Card className="v-fbuilder__stat">
          <p className="v-fbuilder__stat-label">Files</p>
          <p className="v-fbuilder__stat-value">{tree?.totals.files ?? 0}</p>
        </Card>
        <Card className="v-fbuilder__stat">
          <p className="v-fbuilder__stat-label">Directories</p>
          <p className="v-fbuilder__stat-value">{tree?.directories.length ?? 0}</p>
        </Card>
        <Card className="v-fbuilder__stat">
          <p className="v-fbuilder__stat-label">Pages</p>
          <p className="v-fbuilder__stat-value">{structure?.pages.length ?? 0}</p>
        </Card>
        <Card className="v-fbuilder__stat">
          <p className="v-fbuilder__stat-label">Components</p>
          <p className="v-fbuilder__stat-value">{structure?.components.length ?? 0}</p>
        </Card>
      </div>

      {run !== null && (
        <div className="v-fbuilder__activity" data-testid="project-ai-activity">
          <h3 className="v-fbuilder__section-title">Current AI activity</h3>
          <p>
            <Badge tone={run.state === 'failed' ? 'error' : 'neutral'}>
              {STATE_WORDS[run.state] ?? run.state}
            </Badge>{' '}
            {run.plan !== null ? run.plan.goal : 'No plan yet.'}
          </p>
          {run.changedFiles.length > 0 && (
            <p className="v-fbuilder__meta">{run.changedFiles.join(', ')}</p>
          )}
        </div>
      )}

      <div className="v-fbuilder__overview-grid">
        <div>
          <h3 className="v-fbuilder__section-title">Frontend pages</h3>
          {structureError !== '' ? (
            <p className="v-fbuilder__note" role="alert">
              {structureError}
            </p>
          ) : pages.length === 0 ? (
            <p className="v-fbuilder__note">
              No files are classified as pages yet. Ask the builder for one, or add files through
              the coding agent.
            </p>
          ) : (
            <ul className="v-fbuilder__chips">
              {pages.map((path) => (
                <li key={path}>
                  <button
                    type="button"
                    className="v-fbuilder__chip"
                    onClick={() => onSelectFile(path)}
                  >
                    {path}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <h3 className="v-fbuilder__section-title">Components</h3>
          {components.length === 0 ? (
            <p className="v-fbuilder__note">No components classified yet.</p>
          ) : (
            <ul className="v-fbuilder__chips">
              {components.map((path) => (
                <li key={path}>
                  <button
                    type="button"
                    className="v-fbuilder__chip"
                    onClick={() => onSelectFile(path)}
                  >
                    {path}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {sections.length > 0 && (
            <ul className="v-fbuilder__section-counts">
              {sections.map((section) => (
                <li key={section.section}>
                  {section.label}: <strong>{section.count}</strong>
                  {section.omitted > 0 ? ` (${section.omitted} more)` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="v-fbuilder__section-title">Recent changes</h3>
          {recent.length === 0 ? (
            <p className="v-fbuilder__note">
              No changes are recorded yet. The first look at a repository is a baseline.
            </p>
          ) : (
            <ul className="v-fbuilder__changes-list">
              {recent.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="v-fbuilder__link"
                    onClick={() => onSelectFile(entry.path)}
                  >
                    {entry.path}
                  </button>{' '}
                  <span className="v-fbuilder__kind">{KIND_WORDS[entry.changeKind]}</span>{' '}
                  <span className="v-fbuilder__muted">
                    {entry.actor} · revision {entry.revision} · {relativeTime(entry.at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="v-fbuilder__start">
        <h3 className="v-fbuilder__section-title">Start building</h3>
        {tree !== null && tree.files.length === 0 ? (
          <EmptyState
            title="This project has no files yet"
            description="Describe the first page or component you want and the coding agent will plan it."
            action={{ label: 'Describe a first page', onClick: onStartBuilding }}
          />
        ) : (
          <p className="v-fbuilder__note">
            Ask for a page, a component or a design improvement in the AI builder panel. Nothing is
            written until you approve the plan.
          </p>
        )}
      </div>
    </section>
  );
}
