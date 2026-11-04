import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Dialog, Input, Select, Spinner, useToast } from '../../components/ui';
import {
  archiveBranch,
  createBranch,
  deleteBranch,
  getBranch,
  listBranches,
  renameBranch,
  switchBranch,
  unarchiveBranch,
  type BranchDetail,
  type BranchView,
} from '../../api/branches';
import { errorMessage } from '../../api/client';

/**
 * Branch selector and management (Step 38).
 *
 * A branch is its own copy of the project's files with its own history, so
 * choosing one changes which files the rest of the panel shows. Switching only
 * changes the selection: no file is read, written or copied by it.
 *
 * Deleting removes the branch's NAME. Its files and versions stay on the
 * server, which the confirmation says in plain words rather than implying they
 * are destroyed.
 */

type Mode = null | 'create' | 'rename' | 'delete';

export interface BranchBarProps {
  readonly projectId: string;
  /** Called whenever the branch in view changes, with that branch. */
  readonly onBranchChange: (branch: BranchView | null) => void;
  /** Bumped by the parent after a restore or capture, so the bar can refresh. */
  readonly refreshKey?: number;
}

export function BranchBar({ projectId, onBranchChange, refreshKey = 0 }: BranchBarProps) {
  const { toast } = useToast();
  const [branches, setBranches] = useState<readonly BranchView[] | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [showArchived, setShowArchived] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [detail, setDetail] = useState<BranchDetail | null>(null);

  const selected = branches?.find((b) => b.id === selectedId) ?? null;

  // The parent's callback is read through a ref, not listed as a dependency of
  // load(). A parent that passes a new function on every render would otherwise
  // recreate load(), re-run the effect that calls it, and so load again, for
  // ever: the callback sets parent state, which renders the parent, which makes
  // the next new function.
  const onChangeRef = useRef(onBranchChange);
  onChangeRef.current = onBranchChange;

  const load = useCallback(
    async (prefer?: string) => {
      setLoadError(null);
      try {
        const list = await listBranches(projectId, { includeArchived: showArchived });
        setBranches(list.branches);
        const keep = prefer ?? selectedId;
        const next =
          list.branches.find((b) => b.id === keep) ??
          list.branches.find((b) => b.id === list.activeBranchId) ??
          list.branches[0] ??
          null;
        setSelectedId(next?.id ?? '');
        onChangeRef.current(next);
      } catch (failure) {
        setLoadError(errorMessage(failure));
      }
    },
    // selectedId is read as a default only; reloading on every selection would loop.
    [projectId, showArchived],
  );

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (failure) {
      setActionError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const choose = (id: string): void => {
    setSelectedId(id);
    const next = branches?.find((b) => b.id === id) ?? null;
    onChangeRef.current(next);
    if (next === null || next.state === 'archived') return;
    // Remember the choice on the server too, so other views agree on it.
    void switchBranch(projectId, id).catch(() => undefined);
  };

  const openMode = (next: Exclude<Mode, null>): void => {
    setActionError(null);
    setName(next === 'rename' ? (selected?.name ?? '') : '');
    setDescription(next === 'rename' ? (selected?.description ?? '') : '');
    setDetail(null);
    setMode(next);
    if (next === 'delete' && selected !== null) {
      void getBranch(projectId, selected.id)
        .then(setDetail)
        .catch((failure) => setActionError(errorMessage(failure)));
    }
  };

  const closeMode = (): void => {
    if (busy) return;
    setMode(null);
    setActionError(null);
  };

  const submitCreate = (): void => {
    if (name.trim() === '') return;
    void run(async () => {
      const created = await createBranch(projectId, {
        name: name.trim(),
        ...(description.trim() !== '' ? { description: description.trim() } : {}),
        ...(selected !== null ? { fromBranchId: selected.id } : {}),
      });
      toast(`Branch "${created.name}" created`, { tone: 'success' });
      setMode(null);
      await load(created.id);
      await switchBranch(projectId, created.id).catch(() => undefined);
    });
  };

  const submitRename = (): void => {
    if (selected === null || name.trim() === '') return;
    void run(async () => {
      await renameBranch(projectId, selected.id, {
        name: name.trim(),
        description: description.trim(),
      });
      toast('Branch updated', { tone: 'success' });
      setMode(null);
      await load(selected.id);
    });
  };

  const submitDelete = (): void => {
    if (selected === null) return;
    void run(async () => {
      await deleteBranch(projectId, selected.id);
      toast(`Branch "${selected.name}" removed`, { tone: 'info' });
      setMode(null);
      await load('');
    });
  };

  const toggleArchive = (): void => {
    if (selected === null) return;
    void run(async () => {
      if (selected.state === 'archived') {
        await unarchiveBranch(projectId, selected.id);
        toast(`Branch "${selected.name}" restored`, { tone: 'success' });
      } else {
        await archiveBranch(projectId, selected.id);
        toast(`Branch "${selected.name}" archived`, { tone: 'info' });
      }
      await load(selected.id);
    });
  };

  if (loadError !== null) {
    return (
      <p className="v-preview__failure" role="alert">
        Could not load branches: {loadError}
      </p>
    );
  }
  if (branches === null) {
    return (
      <p className="v-muted">
        <Spinner aria-label="Loading branches" /> Loading branches…
      </p>
    );
  }
  if (branches.length === 0) {
    return <p className="v-muted">This project has no files to branch yet.</p>;
  }

  return (
    <div className="v-branch-bar" role="group" aria-label="Branches">
      <div className="v-branch-bar__row">
        <Select
          label="Branch"
          value={selectedId}
          options={branches.map((b) => ({
            value: b.id,
            label: `${b.name}${b.isDefault ? ' (default)' : ''}${b.state === 'archived' ? ' (archived)' : ''}`,
          }))}
          onChange={(event) => choose(event.target.value)}
        />
        {selected !== null && selected.state === 'archived' ? (
          <Badge tone="neutral">Archived</Badge>
        ) : null}
      </div>

      {selected?.description ? <p className="v-muted">{selected.description}</p> : null}

      <div className="v-branch-bar__actions">
        <Button size="sm" onClick={() => openMode('create')} disabled={busy}>
          New branch
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => openMode('rename')}
          disabled={busy || selected === null}
        >
          Rename
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={toggleArchive}
          disabled={busy || selected === null || selected.isDefault}
          title={selected?.isDefault ? 'The default branch cannot be archived.' : undefined}
        >
          {selected?.state === 'archived' ? 'Unarchive' : 'Archive'}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => openMode('delete')}
          disabled={busy || selected === null || selected.isDefault}
          title={selected?.isDefault ? 'The default branch cannot be deleted.' : undefined}
        >
          Delete
        </Button>
        <label className="v-branch-bar__toggle">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />{' '}
          Show archived
        </label>
      </div>

      {actionError !== null && mode === null ? (
        <p className="v-preview__failure" role="alert">
          {actionError}
        </p>
      ) : null}

      {mode === 'create' || mode === 'rename' ? (
        <Dialog
          open
          title={mode === 'create' ? 'New branch' : 'Rename branch'}
          onClose={closeMode}
          footer={
            <>
              <Button variant="secondary" onClick={closeMode} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={mode === 'create' ? submitCreate : submitRename}
                disabled={busy || name.trim() === ''}
              >
                {busy ? 'Saving…' : mode === 'create' ? 'Create branch' : 'Save'}
              </Button>
            </>
          }
        >
          {mode === 'create' && selected !== null ? (
            <p className="v-muted">
              The new branch starts as a copy of “{selected.name}” as it is now. Changes on one
              branch never appear on the other.
            </p>
          ) : null}
          <Input
            label="Name"
            value={name}
            maxLength={64}
            onChange={(event) => setName(event.target.value)}
          />
          <Input
            label="Description (optional)"
            value={description}
            maxLength={500}
            onChange={(event) => setDescription(event.target.value)}
          />
          {actionError !== null ? (
            <p className="v-preview__failure" role="alert">
              {actionError}
            </p>
          ) : null}
        </Dialog>
      ) : null}

      {mode === 'delete' && selected !== null ? (
        <Dialog
          open
          title={`Delete branch “${selected.name}”?`}
          onClose={closeMode}
          footer={
            <>
              <Button variant="secondary" onClick={closeMode} disabled={busy}>
                Keep it
              </Button>
              <Button
                variant="primary"
                onClick={submitDelete}
                disabled={busy || detail === null || !detail.deletable}
              >
                {busy ? 'Deleting…' : 'Delete branch'}
              </Button>
            </>
          }
        >
          {detail === null && actionError === null ? (
            <p className="v-muted">
              <Spinner aria-label="Checking" /> Checking whether this is safe…
            </p>
          ) : detail !== null && !detail.deletable ? (
            <p role="alert">{detail.deleteBlockedReason ?? 'This branch cannot be deleted.'}</p>
          ) : (
            <p>
              The branch will no longer be listed. Its files and saved versions are kept on the
              server, so nothing you wrote is destroyed by this.
            </p>
          )}
          {actionError !== null ? (
            <p className="v-preview__failure" role="alert">
              {actionError}
            </p>
          ) : null}
        </Dialog>
      ) : null}
    </div>
  );
}
