import { Badge, Button, Checkbox } from '../../components/ui';
import type { ExcludedFile, ExportView } from '../../api/exports';
import type { DownloadState } from './useExport';
import {
  depthOf,
  failureAdvice,
  formatBytes,
  isCovered,
  minutesLeft,
  pluralFiles,
  reasonLabel,
  scopeSummary,
  statusLabel,
  statusTone,
  type TreeEntry,
} from './view-model';

/**
 * The parts of the export page. Each shows only what the server reported: file
 * names, reasons, sizes and hashes. No part ever shows file content or a
 * matched secret, because none is ever sent to the browser.
 */

export function Picker({
  entries,
  selected,
  onToggle,
  disabled,
}: {
  readonly entries: readonly TreeEntry[];
  readonly selected: ReadonlySet<string>;
  readonly onToggle: (path: string) => void;
  readonly disabled: boolean;
}) {
  if (entries.length === 0) {
    return <p className="v-export__note">This project has no files yet.</p>;
  }
  return (
    <ul className="v-export__picker" aria-label="Files and folders to export">
      {entries.map((entry) => {
        const covered = isCovered(entry.path, selected);
        const direct = selected.has(entry.path);
        const name = entry.path.split('/').pop() ?? entry.path;
        return (
          <li
            key={entry.path}
            className="v-export__picker-row"
            style={{ paddingInlineStart: `${depthOf(entry.path) * 16}px` }}
          >
            <Checkbox
              label={
                <span className="v-export__picker-name">
                  <span className="v-export__picker-kind" aria-hidden="true">
                    {entry.type === 'directory' ? '▸' : '·'}
                  </span>
                  {name}
                  {entry.type === 'directory' ? '/' : ''}
                </span>
              }
              checked={covered}
              // A child of a chosen folder is covered by it: it can't be toggled
              // on its own until the folder is un-chosen.
              disabled={disabled || (covered && !direct)}
              onChange={() => onToggle(entry.path)}
              aria-label={`${entry.type === 'directory' ? 'Folder' : 'File'} ${entry.path}`}
            />
          </li>
        );
      })}
    </ul>
  );
}

export function ExcludedPanel({ excluded }: { readonly excluded: readonly ExcludedFile[] }) {
  if (excluded.length === 0) return null;
  return (
    <section
      className="v-export__panel v-export__panel--excluded"
      aria-labelledby="export-excluded-title"
      data-testid="export-excluded"
    >
      <h2 id="export-excluded-title" className="v-export__panel-title">
        Left out of the archive ({excluded.length})
      </h2>
      <p className="v-export__note">
        These files were not included. Their contents were never shown to this page. The check is a
        safeguard, not a guarantee: review your code before sharing it.
      </p>
      <ul className="v-export__excluded">
        {excluded.map((file) => (
          <li key={file.path} className="v-export__excluded-row">
            <div className="v-export__excluded-head">
              <code className="v-export__path">{file.path}</code>
              <Badge tone="warning">{reasonLabel(file.reason)}</Badge>
            </div>
            <p className="v-export__excluded-detail">{file.detail}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ResultCard({
  view,
  download,
  validating,
  now,
  onDownload,
  onValidate,
  onDiscard,
}: {
  readonly view: ExportView;
  readonly download: DownloadState;
  readonly validating: boolean;
  readonly now: number;
  readonly onDownload: () => void;
  readonly onValidate: () => void;
  readonly onDiscard: () => void;
}) {
  const left = minutesLeft(view.expiresAt, now);
  return (
    <section
      className="v-export__panel"
      aria-labelledby="export-result-title"
      data-testid="export-result"
    >
      <div className="v-export__panel-head">
        <h2 id="export-result-title" className="v-export__panel-title">
          {scopeSummary(view)}
        </h2>
        <Badge tone={statusTone(view.status)} data-testid="export-status">
          {statusLabel(view.status)}
        </Badge>
      </div>

      {view.status === 'ready' && (
        <>
          <dl className="v-export__facts">
            <div>
              <dt>Files</dt>
              <dd>{pluralFiles(view.totals.files)}</dd>
            </div>
            <div>
              <dt>Source size</dt>
              <dd>{formatBytes(view.totals.bytes)}</dd>
            </div>
            <div>
              <dt>Archive</dt>
              <dd>{formatBytes(view.archiveBytes ?? 0)}</dd>
            </div>
            <div>
              <dt>Revision</dt>
              <dd>{view.revision}</dd>
            </div>
          </dl>
          {view.archiveHash !== null && (
            <p className="v-export__hash">
              SHA-256 <code>{view.archiveHash}</code>
            </p>
          )}
          {view.consistencyRetries > 0 && (
            <p className="v-export__note">
              The project changed while it was being read, so it was read again. Every file in this
              archive comes from the same revision.
            </p>
          )}
          {left !== null && (
            <p className="v-export__note">
              {left > 0
                ? `Available to download for about ${left} more minute${left === 1 ? '' : 's'}.`
                : 'This download is about to expire.'}
            </p>
          )}
          <div className="v-export__actions">
            <Button
              onClick={onDownload}
              loading={download.kind === 'working'}
              data-testid="export-download"
            >
              Download ZIP
            </Button>
            <Button
              variant="secondary"
              onClick={onValidate}
              loading={validating}
              data-testid="export-validate"
            >
              Check archive
            </Button>
            <Button variant="ghost" onClick={onDiscard} data-testid="export-discard">
              Delete export
            </Button>
          </div>
          <DownloadNote download={download} />
        </>
      )}

      {view.status === 'failed' && view.failure !== null && (
        <div role="alert" className="v-export__failure" data-testid="export-failure">
          <strong>{failureAdvice(view.failure.code)}</strong>
          <p>{view.failure.message}</p>
        </div>
      )}

      {view.status === 'expired' && (
        <p role="status" className="v-export__note" data-testid="export-expired">
          This export has expired. Run it again to get a fresh file.
        </p>
      )}
    </section>
  );
}

function DownloadNote({ download }: { readonly download: DownloadState }) {
  if (download.kind === 'done') {
    return (
      <p role="status" className="v-export__ok" data-testid="export-download-done">
        {download.verified
          ? 'Saved. The file matched its recorded checksum.'
          : 'Saved. This browser could not verify the checksum.'}
      </p>
    );
  }
  if (download.kind === 'failed') {
    return (
      <p role="alert" className="v-export__error" data-testid="export-download-failed">
        {download.message}
      </p>
    );
  }
  return null;
}
