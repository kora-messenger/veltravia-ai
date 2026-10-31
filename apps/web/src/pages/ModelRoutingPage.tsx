import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Input, Select, Switch } from '../components/ui';
import { errorMessage } from '../api/client';
import * as api from '../api/model-router';

/**
 * Model routing (Step 28).
 *
 * The screen answers three questions honestly:
 *   1. which models can I reach right now;
 *   2. which model will run this kind of task, and why;
 *   3. what can my models not do yet.
 *
 * Nothing here executes a model call. "Explain the choice" runs the real router,
 * so a refusal on this page is the refusal a real run would get - never a
 * simulation of one.
 */

function modelValue(model: api.RouterModel): string {
  return `${model.connectionId}::${model.modelId}`;
}

function parseModelValue(value: string): { connectionId: string; modelId: string } | null {
  const index = value.indexOf('::');
  if (index <= 0) return null;
  return { connectionId: value.slice(0, index), modelId: value.slice(index + 2) };
}

export function ModelRoutingPage() {
  const [overview, setOverview] = useState<api.RouterOverview | null>(null);
  const [decisions, setDecisions] = useState<readonly api.RoutingDecision[]>([]);
  const [check, setCheck] = useState<api.RoutingDecision | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [taskCategory, setTaskCategory] = useState('general-conversation');
  const [projectId, setProjectId] = useState('');
  const [projectModel, setProjectModel] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextOverview, nextDecisions] = await Promise.all([
        api.getOverview(),
        api.listDecisions(3),
      ]);
      setOverview(nextOverview);
      setDecisions(nextDecisions.decisions);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const modelOptions = useMemo<readonly { value: string; label: string }[]>(() => {
    if (overview === null) return [];
    return overview.catalog
      .filter((model) => model.available)
      .map((model) => ({
        value: modelValue(model),
        label: `${model.displayName} · ${model.providerName}`,
      }));
  }, [overview]);

  const save = useCallback(
    async (update: Parameters<typeof api.savePreferences>[0], message: string) => {
      setBusy(true);
      setError('');
      setNotice('');
      try {
        const saved = await api.savePreferences(update);
        setOverview((current) =>
          current === null ? current : { ...current, preferences: saved.preferences },
        );
        setNotice(
          saved.appliedToExecution === false && saved.mirrorNote
            ? `${message} ${saved.mirrorNote}`
            : message,
        );
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const runCheck = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const { decision } = await api.routeTask({
        category: taskCategory,
        ...(projectId.trim().length > 0 ? { projectId: projectId.trim() } : {}),
      });
      setCheck(decision);
      const recent = await api.listDecisions(3);
      setDecisions(recent.decisions);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [taskCategory, projectId]);

  if (loading) {
    return (
      <div className="v-page">
        <header className="v-page__header">
          <h1 className="v-page__title">Model routing</h1>
        </header>
        <p className="v-connections__empty">Reading your model catalog…</p>
      </div>
    );
  }

  const preferences = overview?.preferences;
  const hasModels = overview !== null && overview.catalog.length > 0;
  const preferenceKind = preferences?.preference ?? 'balanced';
  const selectedDefault = preferences?.defaultModel
    ? `${preferences.defaultModel.connectionId}::${preferences.defaultModel.modelId}`
    : '';

  return (
    <div className="v-page">
      <header className="v-page__header">
        <h1 className="v-page__title">Model routing</h1>
        <p className="v-page__subtitle">
          One place decides which model runs a task. Automatic selection picks the best fit among
          the providers you connected; you can always pin a specific model.
        </p>
      </header>

      {error !== '' && (
        <p className="v-connections__error" role="alert">
          {error}
        </p>
      )}
      {notice !== '' && (
        <p className="v-connections__notice" role="status">
          {notice}
        </p>
      )}

      {!hasModels ? (
        <section className="v-connections__card" aria-label="No models available">
          <h2 className="v-connections__card-title">No model to choose from yet</h2>
          <p className="v-connections__card-text">
            Connect a provider in AI providers and its models appear here. Until then routing
            explains why it cannot run a task instead of guessing.
          </p>
          {overview?.blockedReason !== undefined && (
            <p className="v-connections__card-text">{overview.blockedReason}</p>
          )}
        </section>
      ) : (
        <>
          <section className="v-connections__card" aria-label="Routing defaults">
            <h2 className="v-connections__card-title">How models are chosen</h2>
            <div className="v-ai__row">
              <Switch
                checked={preferences?.autoSelect ?? true}
                onChange={(checked) =>
                  void save(
                    { autoSelect: checked },
                    checked ? 'Automatic selection is on.' : 'Your default model is pinned.',
                  )
                }
                label="Choose a model automatically when I have not picked one"
              />
            </div>
            <div className="v-ai__row">
              <label className="v-ai__field">
                <span className="v-connections__card-text">What matters most</span>
                <Select
                  value={preferenceKind}
                  onChange={(event) =>
                    void save(
                      { preference: event.target.value as api.PreferenceKind },
                      'Preference saved.',
                    )
                  }
                  options={[
                    { value: 'balanced', label: 'Balanced' },
                    { value: 'stronger-reasoning', label: 'Stronger reasoning' },
                    { value: 'faster', label: 'Faster response' },
                    { value: 'lower-cost', label: 'Lower cost' },
                  ]}
                />
              </label>
              <label className="v-ai__field">
                <span className="v-connections__card-text">Default model</span>
                <Select
                  value={selectedDefault}
                  onChange={(event) => {
                    const parsed = parseModelValue(event.target.value);
                    void save(
                      { defaultModel: parsed },
                      parsed === null ? 'Default model cleared.' : 'Default model saved.',
                    );
                  }}
                  options={[
                    { value: '', label: 'Let the router decide' },
                    ...modelOptions.map((row) => ({ value: row.value, label: row.label })),
                  ]}
                />
              </label>
            </div>
            <div className="v-ai__row">
              <Switch
                checked={preferences?.allowFallback ?? false}
                onChange={(checked) =>
                  void save(
                    { allowFallback: checked },
                    checked
                      ? 'A compatible alternative may be used when your chosen model cannot run a task.'
                      : 'Your chosen model is never swapped automatically.',
                  )
                }
                label="Allow a compatible alternative when my chosen model cannot run this task"
              />
            </div>
            <p className="v-connections__card-text">
              {preferenceKind === 'lower-cost'
                ? 'Cost comparison is unavailable: no reliable per-model pricing is configured, so routing will not claim a model is cheapest.'
                : preferenceKind === 'faster'
                  ? 'Speed is ranked from response times measured in this session. Until something has run there is nothing to rank, and routing says so.'
                  : 'A preference never skips the capability check: a model that cannot do the task is never chosen.'}
            </p>
            <p className="v-connections__mode">{overview?.persistence}</p>
          </section>

          <section className="v-connections__card" aria-label="Connected models">
            <h2 className="v-connections__card-title">
              Your models ({overview?.catalog.length} from {overview?.providerCount} provider
              {overview?.providerCount === 1 ? '' : 's'})
            </h2>
            <div className="v-ai__grid">
              {(overview?.catalog ?? []).map((model) => (
                <article key={modelValue(model)} className="v-connections__card">
                  <h3 className="v-connections__card-title">{model.displayName}</h3>
                  <p className="v-connections__card-text">{model.providerName}</p>
                  <p className="v-ai__capabilities">
                    {model.capabilities.map((capability) => (
                      <Badge key={capability}>{api.capabilityWords(capability)}</Badge>
                    ))}
                  </p>
                  <p className="v-connections__card-text">
                    {model.available ? 'Ready to use' : (model.unavailableReason ?? 'Unavailable')}
                  </p>
                  <p className="v-connections__card-text">
                    {model.contextWindowTokens === null
                      ? 'Context window not reported'
                      : `${model.contextWindowTokens.toLocaleString('en-US')} token window`}
                    {' · '}
                    {model.capabilitySource === 'provider-reported'
                      ? 'capabilities reported by the vendor'
                      : 'capabilities from the provider catalog'}
                  </p>
                </article>
              ))}
            </div>
            {(overview?.catalogNotes.length ?? 0) > 0 && (
              <ul className="v-ai__notes">
                {(overview?.catalogNotes ?? []).map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="v-connections__card" aria-label="Task support">
            <h2 className="v-connections__card-title">What your models can handle</h2>
            <div className="v-ai__grid">
              {(overview?.categories ?? []).map((category) => (
                <article key={category.category} className="v-connections__card">
                  <h3 className="v-connections__card-title">{category.displayName}</h3>
                  <p className="v-connections__card-text">{category.description}</p>
                  <p className="v-connections__card-text">
                    {category.supported
                      ? `${category.modelCount} model${category.modelCount === 1 ? '' : 's'} can run this`
                      : (category.reason ?? 'No model can run this yet')}
                  </p>
                </article>
              ))}
            </div>
          </section>

          <section className="v-connections__card" aria-label="Why this model">
            <h2 className="v-connections__card-title">Why this model?</h2>
            <div className="v-ai__row">
              <label className="v-ai__field">
                <span className="v-connections__card-text">Task</span>
                <Select
                  value={taskCategory}
                  onChange={(event) => setTaskCategory(event.target.value)}
                  options={(overview?.categories ?? []).map((category) => ({
                    value: category.category,
                    label: category.displayName,
                  }))}
                />
              </label>
              <Button onClick={() => void runCheck()} disabled={busy}>
                {busy ? 'Checking…' : 'Explain the choice'}
              </Button>
            </div>

            {check !== null && (
              <div className="v-ai__decision" role="status">
                <p className="v-connections__card-text">{check.summary}</p>
                <p className="v-connections__card-text">
                  Decided by: {api.decidedByWords(check.decidedBy)}
                  {check.selected !== null && (
                    <>
                      {' · '}
                      {check.selected.displayName} via {check.selected.providerName}
                    </>
                  )}
                </p>
                {check.warnings.map((warning) => (
                  <p key={warning} className="v-connections__card-text">
                    {warning}
                  </p>
                ))}
                {check.rejected.length > 0 && (
                  <details>
                    <summary>
                      {check.rejected.length} model{check.rejected.length === 1 ? '' : 's'} not used
                    </summary>
                    <ul className="v-ai__notes">
                      {check.rejected.map((entry) => (
                        <li key={`${entry.providerId}-${entry.modelId}`}>
                          {entry.displayName} ({entry.providerName}) {entry.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}

            {check === null && decisions.length > 0 && (
              <div className="v-ai__decision">
                <p className="v-connections__card-text">Most recent: {decisions[0]?.summary}</p>
              </div>
            )}
          </section>

          <section className="v-connections__card" aria-label="Project model">
            <h2 className="v-connections__card-title">A project of its own</h2>
            <p className="v-connections__card-text">
              Give one project its own model. It overrides your default for that project only.
            </p>
            <div className="v-ai__row">
              <label className="v-ai__field">
                <span className="v-connections__card-text">Project id</span>
                <Input
                  value={projectId}
                  onChange={(event) => setProjectId(event.target.value)}
                  placeholder="prj_…"
                />
              </label>
              <label className="v-ai__field">
                <span className="v-connections__card-text">Model for this project</span>
                <Select
                  value={projectModel}
                  onChange={(event) => setProjectModel(event.target.value)}
                  options={[
                    { value: '', label: 'Use my default' },
                    ...modelOptions.map((row) => ({ value: row.value, label: row.label })),
                  ]}
                />
              </label>
              <Button
                onClick={() => {
                  const parsed = parseModelValue(projectModel);
                  const trimmed = projectId.trim();
                  if (trimmed.length === 0) {
                    setError('Enter the project id first.');
                    return;
                  }
                  void save(
                    { projectPreferences: { [trimmed]: parsed === null ? null : parsed } },
                    parsed === null
                      ? 'That project uses your default again.'
                      : 'Project model saved.',
                  );
                }}
                disabled={busy}
              >
                Save project model
              </Button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
