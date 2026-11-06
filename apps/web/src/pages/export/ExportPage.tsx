import { useMemo, useState } from 'react';

import { Badge, Button, EmptyState, ErrorState, Spinner } from '../../components/ui';
import { navigateToHash } from '../../shell/useHashRoute';
import { ExcludedPanel, Picker, ResultCard } from './ExportSections';
import { useExport, type UseExportDeps } from './useExport';
import {
  pickerEntries,
  pluralFiles,
  scopeSummary,
  statusLabel,
  toggleSelection,
} from './view-model';
import './export.css';

/**
 * Export a project's source code as a ZIP.
 *
 * The page asks the server to export and shows what came back: the archive, and
 * every file that was left out with the reason. It never decides what is safe;
 * the server did. Nothing here needs GitHub.
 */

interface ExportPageProps extends UseExportDeps {
  readonly projectId: string | null;
  /** Injected so tests control the clock. */
  readonly now?: () => number;
}

type Mode = 'project' | 'selection';

export function ExportPage({ projectId, save, now = () => Date.now() }: ExportPageProps) {
  const state = useExport(projectId, save === undefined ? {} : { save });
  const [mode, setMode] = useState<Mode>('project');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const entries = useMemo(
    () => (state.tree === null ? [] : pickerEntries(state.tree.files, state.tree.directories)),
    [state.tree],
  );

  if (state.loading) {
    return (
      <div className="v-export v-export--loading" data-testid="export-page">
        <p className="v-export__note" role="status">
          <Spinner size="sm" aria-label="Loading project" /> Loading project…
        </p>
      </div>
    );
  }
  if (state.loadError !== '' || state.tree === null) {
    return (
      <div className="v-export" data-testid="export-page">
        <ErrorState
          title="Could not open this project"
          description={state.loadError || 'The project could not be found.'}
          retry={{ label: 'Try again', onClick: state.reload }}
        />
      </div>
    );
  }

  const tree = state.tree;
  const empty = tree.totals.files === 0;
  const canStart = !state.busy && (mode === 'project' || selected.size > 0);
  const begin = () =>
    void state.start(
      mode === 'project' ? { scope: 'project' } : { scope: 'selection', paths: [...selected] },
    );

  return (
    <div className="v-export" data-testid="export-page">
      <header className="v-export__header">
        <div className="v-export__identity">
          <h1 className="v-export__title">Export source code</h1>
          <div className="v-export__badges">
            <Badge tone="primary">ZIP download</Badge>
            <Badge tone="neutral">{pluralFiles(tree.totals.files)} in this project</Badge>
          </div>
        </div>
        <Button variant="secondary" onClick={() => navigateToHash(`#/projects/${projectId ?? ''}`)}>
          Back to project
        </Button>
      </header>

      {empty ? (
        <EmptyState
          title="Nothing to export yet"
          description="This project has no files. Add some in the workspace, then come back."
          action={{
            label: 'Open the workspace',
            onClick: () => navigateToHash(`#/projects/${projectId ?? ''}/workspace`),
          }}
        />
      ) : (
        <div className="v-export__grid">
          <section className="v-export__panel" aria-labelledby="export-scope-title">
            <h2 id="export-scope-title" className="v-export__panel-title">
              What to export
            </h2>
            <div className="v-export__modes" role="radiogroup" aria-label="Export scope">
              <label className="v-export__mode">
                <input
                  type="radio"
                  name="export-mode"
                  checked={mode === 'project'}
                  onChange={() => setMode('project')}
                  disabled={state.busy}
                />
                <span>Whole project</span>
              </label>
              <label className="v-export__mode">
                <input
                  type="radio"
                  name="export-mode"
                  checked={mode === 'selection'}
                  onChange={() => setMode('selection')}
                  disabled={state.busy}
                />
                <span>Choose files and folders</span>
              </label>
            </div>

            {mode === 'selection' && (
              <>
                <Picker
                  entries={entries}
                  selected={selected}
                  onToggle={(path) => setSelected((current) => toggleSelection(current, path))}
                  disabled={state.busy}
                />
                <p className="v-export__note" data-testid="export-selected-count">
                  {selected.size === 0
                    ? 'Nothing selected yet.'
                    : `${selected.size} item${selected.size === 1 ? '' : 's'} selected.`}
                </p>
              </>
            )}

            <p className="v-export__note">
              Credential files such as <code>.env</code> and anything that looks like a key are
              always left out, and listed afterwards.
            </p>
            <div className="v-export__actions">
              <Button
                onClick={begin}
                loading={state.busy}
                disabled={!canStart}
                data-testid="export-start"
              >
                {mode === 'project' ? 'Export project' : 'Export selection'}
              </Button>
            </div>
            {state.busy && (
              <p role="status" className="v-export__progress" data-testid="export-progress">
                <Spinner size="sm" aria-label="Exporting" /> Reading the project and building the
                archive…
              </p>
            )}
            {state.error !== '' && (
              <p role="alert" className="v-export__error" data-testid="export-error">
                {state.error}
              </p>
            )}
          </section>

          <div className="v-export__results">
            {state.current === null ? (
              <section className="v-export__panel" data-testid="export-placeholder">
                <p className="v-export__note">
                  Your archive and the list of anything left out will appear here.
                </p>
              </section>
            ) : (
              <>
                <ResultCard
                  view={state.current}
                  download={state.download}
                  validating={state.validating}
                  now={now()}
                  onDownload={() => void state.downloadCurrent()}
                  onValidate={() => void state.validateCurrent()}
                  onDiscard={() => void state.discardCurrent()}
                />
                {state.validation !== null && (
                  <p
                    role={state.validation.valid ? 'status' : 'alert'}
                    className={state.validation.valid ? 'v-export__ok' : 'v-export__error'}
                    data-testid="export-validation"
                  >
                    {state.validation.valid
                      ? `Archive checked: ${state.validation.entries} files, all matching the export record.`
                      : `Archive problems: ${state.validation.problems.join(' ')}`}
                  </p>
                )}
                <ExcludedPanel excluded={state.current.excluded} />
              </>
            )}

            {state.history.length > 0 && (
              <section className="v-export__panel" aria-labelledby="export-history-title">
                <h2 id="export-history-title" className="v-export__panel-title">
                  Recent exports
                </h2>
                <ul className="v-export__history">
                  {state.history.map((view) => (
                    <li key={view.exportId} className="v-export__history-row">
                      <span>{scopeSummary(view)}</span>
                      <Badge tone="neutral">{statusLabel(view.status)}</Badge>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => state.open(view)}
                        aria-label={`Open export: ${scopeSummary(view)}, ${statusLabel(view.status)}`}
                      >
                        Open
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
