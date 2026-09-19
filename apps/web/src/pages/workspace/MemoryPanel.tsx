import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  ErrorState,
  Input,
  Select,
  Spinner,
  Textarea,
  useToast,
} from '../../components/ui';
import {
  MEMORY_TYPE_OPTIONS,
  archiveMemory,
  approveMemoryCandidate,
  createMemory,
  deleteMemory,
  getMemoryStats,
  listMemories,
  markMemoryStale,
  rejectMemoryCandidate,
  restoreMemory,
  searchMemories,
  verifyMemory,
  type MemoryStatsView,
  type MemoryStatus,
  type MemoryView,
} from '../../api/memories';
import { errorMessage } from '../../api/client';

/**
 * Right-hand workspace panel: project memory (Step 15).
 *
 * The user owns the memory here: they read it, search it, add to it,
 * verify or stale it, and archive or delete it. AI-extracted candidates
 * surface ONLY through this review surface - an explicit approve is the
 * only way a candidate enters AI context. Everything renders the safe
 * normalized view: provenance, confidence, and verification state are
 * always visible, never hidden.
 */

const STATUS_TABS: readonly { value: MemoryStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'candidate', label: 'Candidates' },
  { value: 'archived', label: 'Archived' },
];

const CONFIDENCE_TONE: Record<MemoryView['confidence'], 'success' | 'warning' | 'neutral'> = {
  high: 'success',
  medium: 'warning',
  low: 'neutral',
};

const VERIFICATION_LABEL: Record<MemoryView['verificationStatus'], string> = {
  unverified: 'Unverified',
  verified: 'Verified',
  stale: 'Stale',
};

const VERIFICATION_TONE: Record<
  MemoryView['verificationStatus'],
  'success' | 'warning' | 'neutral'
> = {
  unverified: 'neutral',
  verified: 'success',
  stale: 'warning',
};

function sourceLabel(memory: MemoryView): string {
  if (memory.source.kind === 'user') {
    return 'Added by you';
  }
  if (memory.source.referenceId !== null) {
    return `From ${memory.source.kind.replace(/_/g, ' ')} (${memory.source.referenceId})`;
  }
  return `From ${memory.source.kind.replace(/_/g, ' ')}`;
}

export interface MemoryPanelProps {
  readonly projectId: string;
}

export function MemoryPanel({ projectId }: MemoryPanelProps) {
  const { toast } = useToast();
  const [memories, setMemories] = useState<readonly MemoryView[] | null>(null);
  const [stats, setStats] = useState<MemoryStatsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<MemoryStatus>('active');
  const [searchText, setSearchText] = useState('');
  const [searching, setSearching] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [createContent, setCreateContent] = useState('');
  const [createType, setCreateType] = useState<string>(MEMORY_TYPE_OPTIONS[0] ?? 'project_summary');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(
    async (status: MemoryStatus) => {
      setError(null);
      try {
        const [listed, statsView] = await Promise.all([
          listMemories(projectId, { status }),
          getMemoryStats(projectId),
        ]);
        setMemories(listed);
        setStats(statsView);
      } catch (loadError) {
        setMemories([]);
        setError(errorMessage(loadError));
      }
    },
    [projectId],
  );

  useEffect(() => {
    void reload(statusFilter);
  }, [reload, statusFilter]);

  const runSearch = useCallback(async () => {
    if (searchText.trim() === '') {
      void reload(statusFilter);
      return;
    }
    setSearching(true);
    setError(null);
    try {
      setMemories(await searchMemories(projectId, searchText.trim()));
    } catch (searchError) {
      setError(errorMessage(searchError));
    } finally {
      setSearching(false);
    }
  }, [projectId, reload, searchText, statusFilter]);

  const submitCreate = useCallback(async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createMemory(projectId, {
        title: createTitle.trim(),
        content: createContent,
        type: createType,
        confidence: 'high',
      });
      toast(`Memory "${created.title}" saved.`, { tone: 'success' });
      setCreateTitle('');
      setCreateContent('');
      setShowCreate(false);
      await reload(statusFilter);
    } catch (createFailure) {
      setCreateError(errorMessage(createFailure));
    } finally {
      setCreating(false);
    }
  }, [createContent, createTitle, createType, projectId, reload, statusFilter, toast]);

  const act = useCallback(
    async (memory: MemoryView, action: () => Promise<unknown>, note: string) => {
      setBusyId(memory.id);
      setError(null);
      try {
        await action();
        toast(`${note}: "${memory.title}"`, { tone: 'success' });
        await reload(statusFilter);
      } catch (actionError) {
        setError(errorMessage(actionError));
      } finally {
        setBusyId(null);
      }
    },
    [reload, statusFilter, toast],
  );

  return (
    <section className="v-memory-panel" aria-label="Project memory">
      <header className="v-memory-panel__header">
        <h3 className="v-context-section__title">Project memory</h3>
        {stats !== null && (
          <p className="v-memory-panel__stats">
            {stats.active} active · {stats.candidates} candidate
            {stats.candidates === 1 ? '' : 's'} · {stats.archived} archived
          </p>
        )}
      </header>

      <div className="v-memory-panel__filters" role="group" aria-label="Memory status filter">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            className={
              statusFilter === tab.value
                ? 'v-memory-panel__tab v-memory-panel__tab--active'
                : 'v-memory-panel__tab'
            }
            aria-pressed={statusFilter === tab.value}
            onClick={() => {
              setSearchText('');
              setStatusFilter(tab.value);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <form
        className="v-memory-panel__search"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch();
        }}
      >
        <Input
          type="search"
          label="Search memory"
          hint="Searches active memories the AI can use."
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
        />
        <Button type="submit" variant="secondary" loading={searching}>
          Search
        </Button>
      </form>

      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => setShowCreate((open) => !open)}
      >
        {showCreate ? 'Cancel' : 'Add memory'}
      </Button>

      {showCreate && (
        <form
          className="v-memory-panel__create"
          onSubmit={(event) => {
            event.preventDefault();
            void submitCreate();
          }}
        >
          <Input
            label="Title"
            value={createTitle}
            maxLength={120}
            onChange={(event) => setCreateTitle(event.target.value)}
          />
          <Select
            label="Type"
            value={createType}
            options={MEMORY_TYPE_OPTIONS.map((type) => ({ value: type, label: type }))}
            onChange={(event) => setCreateType(event.target.value)}
          />
          <Textarea
            label="Content"
            hint="Secrets are rejected; memory is reference data, never instructions."
            rows={4}
            maxLength={4000}
            value={createContent}
            onChange={(event) => setCreateContent(event.target.value)}
          />
          {createError !== null && <p className="v-memory-panel__error">{createError}</p>}
          <Button
            type="submit"
            variant="primary"
            loading={creating}
            disabled={createTitle.trim() === '' || createContent === ''}
          >
            Save memory
          </Button>
        </form>
      )}

      {error !== null && (
        <ErrorState
          description={error}
          retry={{ label: 'Retry', onClick: () => void reload(statusFilter) }}
        />
      )}

      {memories === null ? (
        <p className="v-context-empty" aria-live="polite">
          <Spinner size="sm" /> Loading project memory…
        </p>
      ) : memories.length === 0 ? (
        <p className="v-context-empty">
          {statusFilter === 'active'
            ? 'No active memories yet. Add a durable project fact so the AI can use it in runs.'
            : statusFilter === 'candidate'
              ? 'No candidates waiting for review.'
              : 'No archived memories.'}
        </p>
      ) : (
        <ul className="v-memory-panel__list">
          {memories.map((memory) => (
            <li key={memory.id} className="v-memory-panel__item">
              <p className="v-memory-panel__item-title">{memory.title}</p>
              <p className="v-memory-panel__item-content">{memory.content}</p>
              <div className="v-context-meta">
                <Badge tone="neutral">{memory.type}</Badge>
                <Badge tone={CONFIDENCE_TONE[memory.confidence]}>{memory.confidence}</Badge>
                <Badge tone={VERIFICATION_TONE[memory.verificationStatus]}>
                  {VERIFICATION_LABEL[memory.verificationStatus]}
                </Badge>
              </div>
              <p className="v-memory-panel__item-source">{sourceLabel(memory)}</p>
              <div className="v-memory-panel__actions">
                {memory.status === 'candidate' && (
                  <>
                    <Button
                      size="sm"
                      variant="primary"
                      loading={busyId === memory.id}
                      onClick={() =>
                        void act(
                          memory,
                          () => approveMemoryCandidate(projectId, memory.id),
                          'Candidate approved',
                        )
                      }
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busyId === memory.id}
                      onClick={() =>
                        void act(
                          memory,
                          () => rejectMemoryCandidate(projectId, memory.id),
                          'Candidate rejected',
                        )
                      }
                    >
                      Reject
                    </Button>
                  </>
                )}
                {memory.status !== 'candidate' && (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busyId === memory.id}
                      onClick={() =>
                        void act(
                          memory,
                          () => verifyMemory(projectId, memory.id),
                          'Marked verified',
                        )
                      }
                    >
                      Verify
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busyId === memory.id}
                      onClick={() =>
                        void act(
                          memory,
                          () => markMemoryStale(projectId, memory.id),
                          'Marked stale',
                        )
                      }
                    >
                      Mark stale
                    </Button>
                    {memory.status === 'active' ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={busyId === memory.id}
                        onClick={() =>
                          void act(
                            memory,
                            () => archiveMemory(projectId, memory.id),
                            'Memory archived',
                          )
                        }
                      >
                        Archive
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={busyId === memory.id}
                        onClick={() =>
                          void act(
                            memory,
                            () => restoreMemory(projectId, memory.id),
                            'Memory restored',
                          )
                        }
                      >
                        Restore
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="danger"
                      loading={busyId === memory.id}
                      onClick={() =>
                        void act(memory, () => deleteMemory(projectId, memory.id), 'Memory deleted')
                      }
                    >
                      Delete
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
