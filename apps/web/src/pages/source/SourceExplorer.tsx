import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Spinner } from '../../components/ui';
import { errorMessage } from '../../api/client';
import * as api from '../../api/source';

/**
 * Project source explorer (Step 31).
 *
 * A READ-ONLY view of what is actually stored for a project: the real tree,
 * real file contents, and whether a file changed recently. It deliberately is
 * not an editor - that milestone comes later - so nothing here can write.
 *
 * Every state is visible: loading, empty, failed with a retry, and a truncated
 * read that says so rather than silently showing half a file.
 */

interface SourceExplorerProps {
  readonly projectId: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ancestorDirectories(path: string): string[] {
  const segments = path.split('/');
  const directories: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    directories.push(segments.slice(0, index).join('/'));
  }
  return directories;
}

export function SourceExplorer({ projectId }: SourceExplorerProps) {
  const [tree, setTree] = useState<api.SourceTreeView | null>(null);
  const [history, setHistory] = useState<readonly api.FileHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<api.SourceFileContent | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextTree, nextHistory] = await Promise.all([
        api.fetchTree(projectId),
        api.fetchHistory(projectId, 50).catch(() => [] as readonly api.FileHistoryEntry[]),
      ]);
      setTree(nextTree);
      setHistory(nextHistory);
      setSelected((current) => current ?? nextTree.files[0]?.path ?? null);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const recentlyChanged = useMemo(
    () =>
      new Set(history.filter((entry) => entry.changeKind !== 'deleted').map((entry) => entry.path)),
    [history],
  );

  const loadFile = useCallback(
    async (path: string) => {
      setSelected(path);
      setFileLoading(true);
      setFileError('');
      try {
        setFile(await api.fetchFile(projectId, path));
      } catch (readError) {
        setFile(null);
        setFileError(errorMessage(readError));
      } finally {
        setFileLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    if (selected === null) return;
    void loadFile(selected);
  }, [selected, loadFile]);

  const toggle = (directory: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(directory)) next.delete(directory);
      else next.add(directory);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="v-source" data-testid="source-explorer">
        <p className="v-source__state" role="status">
          <Spinner size="sm" aria-label="Loading files" /> Loading project files…
        </p>
      </div>
    );
  }

  if (error !== '') {
    return (
      <div className="v-source" data-testid="source-explorer">
        <p className="v-source__error" role="alert">
          {error}
        </p>
        <Button variant="secondary" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }

  if (tree === null || tree.files.length === 0) {
    return (
      <div className="v-source" data-testid="source-explorer">
        <p className="v-source__state" role="note">
          This project has no files yet. Create one, or ask the builder for a starter plan.
        </p>
      </div>
    );
  }

  const visibleFiles = tree.files.filter((entry) =>
    ancestorDirectories(entry.path).every((directory) => expanded.has(directory)),
  );
  const visibleDirectories = tree.directories.filter((directory) =>
    ancestorDirectories(directory).every((parent) => expanded.has(parent)),
  );

  return (
    <div className="v-source" data-testid="source-explorer">
      <div className="v-source__row">
        <Badge tone="neutral">{tree.totals.files} files</Badge>
        <Badge tone="neutral">{formatBytes(tree.totals.bytes)}</Badge>
        <Badge tone="neutral">revision {tree.rootRevision}</Badge>
        <Button variant="secondary" onClick={() => void load()} aria-label="Refresh files">
          Refresh
        </Button>
      </div>

      <div className="v-source__body">
        <nav className="v-source__tree" aria-label="Project files">
          <ul className="v-source__list">
            {visibleDirectories.map((directory) => {
              const isOpen = expanded.has(directory);
              return (
                <li
                  key={directory}
                  style={{ paddingLeft: `${ancestorDirectories(directory).length * 12}px` }}
                >
                  <button
                    type="button"
                    className="v-source__directory"
                    onClick={() => toggle(directory)}
                    aria-expanded={isOpen}
                  >
                    <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span>{' '}
                    {directory.split('/').pop()}/
                  </button>
                </li>
              );
            })}
            {visibleFiles.map((entry) => (
              <li
                key={entry.path}
                style={{ paddingLeft: `${ancestorDirectories(entry.path).length * 12}px` }}
              >
                <button
                  type="button"
                  className={`v-source__file${selected === entry.path ? ' v-source__file--active' : ''}`}
                  onClick={() => void loadFile(entry.path)}
                  aria-current={selected === entry.path ? 'true' : undefined}
                >
                  {entry.path.split('/').pop()}
                  {recentlyChanged.has(entry.path) && (
                    <span
                      className="v-source__changed"
                      aria-label="recently changed"
                      title="recently changed"
                    >
                      ●
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="v-source__preview">
          {fileLoading && (
            <p className="v-source__state" role="status">
              <Spinner size="sm" aria-label="Loading file" /> Loading file…
            </p>
          )}
          {fileError !== '' && (
            <p className="v-source__error" role="alert">
              {fileError}
            </p>
          )}
          {!fileLoading && fileError === '' && file !== null && (
            <>
              <p className="v-source__meta">
                <code>{file.path}</code> · revision {file.revision} · {formatBytes(file.size)}
              </p>
              {file.truncated && (
                <p className="v-source__note" role="note">
                  This preview is cut at the read limit. The stored file is larger.
                </p>
              )}
              <pre className="v-source__content" aria-label={`Contents of ${file.path}`}>
                {file.content}
              </pre>
            </>
          )}
          {!fileLoading && fileError === '' && file === null && selected !== null && (
            <p className="v-source__state" role="note">
              Select a file to see its contents.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
