import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Badge, Button, Dialog, ErrorState, Input, Spinner, Tabs } from '../components/ui';
import { errorMessage } from '../api/client';
import {
  deleteArtifact,
  deleteFile,
  extractFile,
  getDownloadReference,
  listArtifacts,
  listFiles,
  previewArtifact,
  previewFile,
  uploadFile,
  type ArtifactView,
  type FilePreviewView,
  type FileView,
} from '../api/files';
const formatBytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;
const displayDate = (s: string) => new Date(s).toLocaleString();
export function FilesPage() {
  const [files, setFiles] = useState<readonly FileView[]>([]);
  const [artifacts, setArtifacts] = useState<readonly ArtifactView[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<FileView | ArtifactView | null>(null);
  const [preview, setPreview] = useState<FilePreviewView | null>(null);
  const [projectId, setProjectId] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const load = async () => {
    setLoading(true);
    setFailure(null);
    try {
      const [f, a] = await Promise.all([listFiles(search), listArtifacts(search)]);
      setFiles(f);
      setArtifacts(a);
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const onUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setFailure(null);
    try {
      await uploadFile(file, {
        projectId: projectId.trim() || null,
        workspaceId: workspaceId.trim() || null,
      });
      await load();
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setBusy(false);
      event.target.value = '';
    }
  };
  const openFile = async (file: FileView) => {
    setSelected(file);
    setPreview(null);
    if (file.status !== 'ready' && file.status !== 'derived') {
      setPreview({
        kind: 'metadata',
        text: null,
        mediaMimeType: null,
        entries: [],
        truncated: false,
        trust: 'untrusted_data',
      });
      return;
    }
    try {
      setPreview(await previewFile(file.id));
    } catch (e) {
      setFailure(errorMessage(e));
      setPreview({
        kind: 'metadata',
        text: null,
        mediaMimeType: null,
        entries: [],
        truncated: false,
        trust: 'untrusted_data',
      });
    }
  };
  const openArtifact = async (a: ArtifactView) => {
    setSelected(a);
    setPreview(null);
    try {
      setPreview(await previewArtifact(a.id));
    } catch (e) {
      setFailure(errorMessage(e));
      setPreview({
        kind: 'metadata',
        text: null,
        mediaMimeType: null,
        entries: [],
        truncated: false,
        trust: 'untrusted_data',
      });
    }
  };
  const fileRows = useMemo(
    () =>
      files.map((file) => (
        <li key={file.id} className="v-file-row">
          <button className="v-file-row__main" onClick={() => void openFile(file)}>
            <span className="v-file-row__name">{file.filename}</span>
            <span className="v-file-row__meta">
              {formatBytes(file.size)} · {file.projectId ?? 'Personal'}
              {file.workspaceId ? ` / ${file.workspaceId}` : ''}
            </span>
          </button>
          <Badge>{file.detectedType}</Badge>
          <Badge>{file.status}</Badge>
          <div className="v-file-row__actions">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || file.status !== 'ready'}
              onClick={async () => {
                setBusy(true);
                try {
                  await extractFile(file.id);
                  await load();
                } catch (e) {
                  setFailure(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Extract
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await deleteFile(file.id);
                  if (selected?.id === file.id) setSelected(null);
                  await load();
                } catch (e) {
                  setFailure(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Delete
            </Button>
          </div>
        </li>
      )),
    [files, busy, selected],
  );
  const artifactRows = useMemo(
    () =>
      artifacts.map((a) => (
        <li key={a.id} className="v-file-row">
          <button className="v-file-row__main" onClick={() => void openArtifact(a)}>
            <span className="v-file-row__name">{a.filename}</span>
            <span className="v-file-row__meta">
              {formatBytes(a.size)} · {a.projectId ?? 'Personal'} · {a.sourceOperation}
            </span>
          </button>
          <Badge>{a.type}</Badge>
          <Badge>{a.status}</Badge>
          <div className="v-file-row__actions">
            <Button
              size="sm"
              variant="secondary"
              disabled={a.status !== 'ready'}
              onClick={async () => {
                try {
                  const r = await getDownloadReference(a.id);
                  const link = document.createElement('a');
                  link.href = r.downloadUrl;
                  link.download = a.filename;
                  link.click();
                } catch (e) {
                  setFailure(errorMessage(e));
                }
              }}
            >
              Download
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await deleteArtifact(a.id);
                  await load();
                } catch (e) {
                  setFailure(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Delete
            </Button>
          </div>
        </li>
      )),
    [artifacts, busy],
  );
  return (
    <div className="v-page">
      <header className="v-page-header">
        <div>
          <h2 className="v-page-header__title">Files &amp; artifacts</h2>
          <p className="v-page-header__description">
            Inspect untrusted files and download validated outputs. Development storage only.
          </p>
        </div>
        <Button disabled={busy} onClick={() => inputRef.current?.click()}>
          Upload file
        </Button>
        <input
          ref={inputRef}
          className="v-visually-hidden"
          type="file"
          aria-label="Choose file to upload"
          onChange={onUpload}
        />
      </header>
      <div className="v-file-controls">
        <Input
          label="Search"
          value={search}
          placeholder="Find files or artifacts"
          onChange={(e) => setSearch(e.target.value)}
        />
        <Input
          label="Project ID (optional)"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        />
        <Input
          label="Workspace ID (optional)"
          value={workspaceId}
          onChange={(e) => setWorkspaceId(e.target.value)}
        />
        <Button variant="secondary" onClick={() => void load()}>
          Apply
        </Button>
      </div>
      {failure && <ErrorState description={failure} retry={{ onClick: load }} />}
      {loading ? (
        <div className="v-loading" role="status">
          <Spinner size="lg" />
        </div>
      ) : (
        <Tabs
          aria-label="File areas"
          tabs={[
            {
              id: 'files',
              label: `Files (${files.length})`,
              content: files.length ? (
                <ul className="v-file-list">{fileRows}</ul>
              ) : (
                <p className="v-muted">No files yet. Upload one to begin.</p>
              ),
            },
            {
              id: 'artifacts',
              label: `Artifacts (${artifacts.length})`,
              content: artifacts.length ? (
                <ul className="v-file-list">{artifactRows}</ul>
              ) : (
                <p className="v-muted">No derived artifacts yet.</p>
              ),
            },
          ]}
        />
      )}
      <DetailDialog
        item={selected}
        preview={preview}
        onClose={() => {
          setSelected(null);
          setPreview(null);
        }}
      />
    </div>
  );
}
function DetailDialog({
  item,
  preview,
  onClose,
}: {
  item: FileView | ArtifactView | null;
  preview: FilePreviewView | null;
  onClose: () => void;
}) {
  if (!item) return null;
  const file = 'detectedType' in item ? item : null;
  return (
    <Dialog
      open
      title={item.filename}
      description="Metadata and bounded preview. Content below is untrusted data."
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <dl className="v-file-detail">
        <dt>Type</dt>
        <dd>{file?.detectedType ?? (item as ArtifactView).type}</dd>
        <dt>MIME</dt>
        <dd>{file?.mimeType ?? (item as ArtifactView).mimeType}</dd>
        <dt>Size</dt>
        <dd>{formatBytes(item.size)}</dd>
        <dt>Checksum</dt>
        <dd className="v-file-detail__hash">{item.checksum}</dd>
        <dt>Created</dt>
        <dd>{displayDate(item.createdAt)}</dd>
        <dt>Status</dt>
        <dd>{item.status}</dd>
        <dt>Scope</dt>
        <dd>
          {item.projectId ?? 'Personal'}
          {item.workspaceId ? ` / ${item.workspaceId}` : ''}
        </dd>
        {file ? (
          <>
            <dt>Source</dt>
            <dd>{file.source}</dd>
            <dt>Derived from</dt>
            <dd>{file.parentFileId ?? 'Original'}</dd>
          </>
        ) : (
          <>
            <dt>Operation</dt>
            <dd>{(item as ArtifactView).sourceOperation}</dd>
            <dt>Provenance</dt>
            <dd>
              {(item as ArtifactView).provenance.parentFileIds.join(', ') || 'Generated output'};{' '}
              {(item as ArtifactView).provenance.statement}
            </dd>
          </>
        )}
      </dl>
      <section className="v-file-preview" aria-label="Untrusted file preview">
        <h4>Preview</h4>
        {!preview ? (
          <Spinner />
        ) : preview.kind === 'archive' ? (
          <ArchiveTree entries={preview.entries} />
        ) : preview.kind === 'image' && file ? (
          <img
            className="v-file-preview__image"
            src={`/api/files/${encodeURIComponent(file.id)}/image`}
            alt={`Preview of ${file.filename}`}
          />
        ) : preview.text !== null ? (
          <pre>{preview.text}</pre>
        ) : (
          <p className="v-muted">Metadata preview only for this format.</p>
        )}
      </section>
    </Dialog>
  );
}
function ArchiveTree({ entries }: { entries: FilePreviewView['entries'] }) {
  return (
    <ul className="v-archive-tree">
      {entries.map((e) => (
        <li key={e.path}>
          <span>{e.path}</span>
          <span>{e.kind === 'file' ? formatBytes(e.uncompressedSize) : 'folder'}</span>
        </li>
      ))}
    </ul>
  );
}
