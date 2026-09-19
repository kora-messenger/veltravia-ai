// @vitest-environment jsdom
import { useCallback, useEffect, useState } from 'react';

import { Badge, Button, ErrorState, Input, Spinner, useToast } from '../../components/ui';
import {
  buildIndex,
  extractMemoryCandidates,
  getIndex,
  searchCodebase,
  traceFeature,
  type CodebaseIndexView,
  type CodebaseSearchResultView,
  type CodebaseTraceView,
} from '../../api/codebase';
import { ApiError, errorMessage } from '../../api/client';

/**
 * Workspace codebase panel (Step 16): read-only structural analysis of the
 * selected workspace.
 *
 * Everything rendered here is SAFE analysis metadata the API derived:
 * languages, frameworks, counts, bounded file statuses, symbol search
 * results, and feature traces. Source CONTENT is never shown - the file
 * tree panel remains the content pathway. Memory candidate extraction is
 * explicit and always lands in the memory panel as CANDIDATES for human
 * review, never as active memory.
 */

const INDEX_NOT_FOUND = 'CODEBASE_INDEX_NOT_FOUND';

const PARSE_TONE: Record<string, 'success' | 'warning' | 'neutral'> = {
  parsed: 'success',
  failed: 'warning',
  unsupported: 'neutral',
};

export interface CodebasePanelProps {
  readonly projectId: string;
  readonly workspaceId: string;
}

export function CodebasePanel({ projectId, workspaceId }: CodebasePanelProps) {
  const { toast } = useToast();
  const [index, setIndex] = useState<CodebaseIndexView | null>(null);
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [searchText, setSearchText] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<readonly CodebaseSearchResultView[] | null>(null);

  const [feature, setFeature] = useState('');
  const [tracing, setTracing] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [trace, setTrace] = useState<CodebaseTraceView | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const view = await getIndex(projectId, workspaceId);
      setIndex(view);
      setMissing(false);
    } catch (loadError) {
      setIndex(null);
      if (loadError instanceof ApiError && loadError.code === INDEX_NOT_FOUND) {
        setMissing(true);
        setError(null);
      } else {
        setMissing(false);
        setError(errorMessage(loadError));
      }
    } finally {
      setLoading(false);
    }
  }, [projectId, workspaceId]);

  useEffect(() => {
    setTrace(null);
    setResults(null);
    void reload();
  }, [reload]);

  const onBuild = useCallback(async (): Promise<void> => {
    setBuilding(true);
    setError(null);
    try {
      const built = await buildIndex(projectId, workspaceId);
      setIndex(built.index);
      setMissing(false);
      toast(
        built.incremental && built.changedFiles === 0
          ? 'Analysis is already up to date.'
          : `Analysis complete (${built.changedFiles} file${built.changedFiles === 1 ? '' : 's'} changed).`,
        { tone: 'success' },
      );
    } catch (buildError) {
      setError(errorMessage(buildError));
    } finally {
      setBuilding(false);
    }
  }, [projectId, workspaceId, toast]);

  const onSearch = useCallback(async (): Promise<void> => {
    if (searchText.trim() === '') return;
    setSearching(true);
    setSearchError(null);
    try {
      setResults(await searchCodebase(projectId, workspaceId, searchText.trim()));
    } catch (searchFailure) {
      setResults(null);
      setSearchError(errorMessage(searchFailure));
    } finally {
      setSearching(false);
    }
  }, [projectId, workspaceId, searchText]);

  const onTrace = useCallback(async (): Promise<void> => {
    if (feature.trim() === '') return;
    setTracing(true);
    setTraceError(null);
    try {
      setTrace(await traceFeature(projectId, workspaceId, feature.trim()));
    } catch (traceFailure) {
      setTrace(null);
      setTraceError(errorMessage(traceFailure));
    } finally {
      setTracing(false);
    }
  }, [projectId, workspaceId, feature]);

  const onExtractCandidates = useCallback(async (): Promise<void> => {
    try {
      const count = await extractMemoryCandidates(projectId, workspaceId);
      toast(
        count === 0
          ? 'Nothing durable found worth remembering yet.'
          : `${count} candidate${count === 1 ? '' : 's'} sent to memory for review.`,
        { tone: 'success' },
      );
    } catch (extractError) {
      toast(errorMessage(extractError), { tone: 'error' });
    }
  }, [projectId, workspaceId, toast]);

  return (
    <section className="v-codebase-panel" aria-label="Codebase analysis">
      <header className="v-codebase-panel__header">
        <h3 className="v-context-section__title">Codebase analysis</h3>
        {index !== null && (
          <Badge
            tone={
              index.status === 'current'
                ? 'success'
                : index.status === 'stale'
                  ? 'warning'
                  : 'neutral'
            }
          >
            {index.status === 'current'
              ? 'Current'
              : index.status === 'stale'
                ? 'Stale'
                : 'Unavailable'}
          </Badge>
        )}
      </header>

      {loading && (
        <p className="v-codebase-panel__stats">
          <Spinner size="sm" /> Loading analysis…
        </p>
      )}
      {error !== null && (
        <ErrorState
          title="Analysis unavailable"
          description={error}
          retry={{ label: 'Retry', onClick: () => void reload() }}
        />
      )}

      {!loading && error === null && missing && (
        <div className="v-codebase-panel__empty">
          <p>This workspace has not been analyzed yet.</p>
          <Button onClick={() => void onBuild()} disabled={building}>
            {building ? 'Analyzing…' : 'Analyze workspace'}
          </Button>
        </div>
      )}

      {!loading && error === null && index !== null && (
        <div className="v-codebase-panel__body">
          <div className="v-codebase-panel__actions">
            <Button variant="secondary" onClick={() => void onBuild()} disabled={building}>
              {building
                ? 'Analyzing…'
                : index.status === 'stale'
                  ? 'Refresh analysis'
                  : 'Re-analyze'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => void onExtractCandidates()}
              disabled={index.buildState !== 'completed'}
            >
              Extract memory candidates
            </Button>
          </div>

          <p className="v-codebase-panel__stats">
            {index.fileCount} files · {index.symbolCount} symbols · {index.routeCount} routes ·{' '}
            {index.componentCount} components
          </p>

          {index.languages.length > 0 && (
            <p className="v-codebase-panel__meta">Languages: {index.languages.join(', ')}</p>
          )}
          {index.frameworks.length > 0 && (
            <p className="v-codebase-panel__meta">
              Frameworks: {index.frameworks.map((framework) => framework.name).join(', ')}
            </p>
          )}
          {index.flaggedSecretFileCount > 0 && (
            <p className="v-codebase-panel__warning">
              {index.flaggedSecretFileCount} file{index.flaggedSecretFileCount === 1 ? '' : 's'}{' '}
              flagged for secret-shaped content. Values are never stored or shown.
            </p>
          )}

          <div className="v-codebase-panel__search" role="search">
            <Input
              label="Find symbols"
              placeholder="Search functions, classes, components…"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void onSearch();
              }}
            />
            <Button variant="secondary" onClick={() => void onSearch()} disabled={searching}>
              {searching ? 'Searching…' : 'Search'}
            </Button>
          </div>
          {searchError !== null && <p className="v-codebase-panel__error">{searchError}</p>}
          {results !== null && (
            <ul className="v-codebase-panel__results" aria-label="Symbol search results">
              {results.length === 0 && <li>No symbols matched that search.</li>}
              {results.map((result, position) => (
                <li key={`${result.title}-${position}`}>
                  <span className="v-codebase-panel__result-title">{result.title}</span>
                  <span className="v-codebase-panel__result-detail">{result.detail}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="v-codebase-panel__trace">
            <Input
              label="Trace a feature"
              placeholder="e.g. login, checkout, search"
              value={feature}
              onChange={(event) => setFeature(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void onTrace();
              }}
            />
            <Button variant="secondary" onClick={() => void onTrace()} disabled={tracing}>
              {tracing ? 'Tracing…' : 'Trace'}
            </Button>
          </div>
          {traceError !== null && <p className="v-codebase-panel__error">{traceError}</p>}
          {trace !== null && (
            <div className="v-codebase-panel__trace-result">
              {trace.nodes.length === 0 ? (
                <p>No evidence found for that feature.</p>
              ) : (
                <>
                  <ul aria-label="Feature trace">
                    {trace.nodes.map((node, position) => (
                      <li key={`${node.label}-${position}`}>
                        <span className="v-codebase-panel__result-title">{node.label}</span>
                        <span className="v-codebase-panel__result-detail">{node.reason}</span>
                      </li>
                    ))}
                  </ul>
                  {trace.truncated && <p>Trace truncated to keep it readable.</p>}
                </>
              )}
            </div>
          )}

          {index.files.length > 0 && (
            <details className="v-codebase-panel__files">
              <summary>Files ({index.files.length})</summary>
              <ul>
                {index.files.map((file) => (
                  <li key={file.path}>
                    <span className="v-codebase-panel__file-path">{file.path}</span>
                    <Badge tone={PARSE_TONE[file.parseStatus] ?? 'neutral'}>
                      {file.parseStatus}
                    </Badge>
                    {file.flaggedSecrets && <Badge tone="warning">secrets flagged</Badge>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
