import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card, Select, Spinner, Textarea, useToast } from '../components/ui';
import { errorMessage } from '../api/client';
import * as api from '../api/reasoning';

/**
 * Reasoning workspace (Step 27).
 *
 * The page renders what the engine reports and nothing more: the provider and
 * model that actually ran, the phases it went through, the answer as it streams,
 * the tools it called, and any decision it is waiting on. A simulated run is
 * labelled simulated everywhere it appears, and a failed run stays failed rather
 * than being dressed up as an answer.
 */

interface PhaseView {
  readonly phase: string;
  readonly detail?: string;
}

const PHASE_LABELS: Record<string, string> = {
  validate: 'Check request',
  classify: 'Classify task',
  plan: 'Plan',
  execute: 'Work',
  synthesize: 'Answer',
  assess: 'Assess',
  complete: 'Done',
};

const PROFILE_FALLBACK: api.ReasoningProfileView[] = [
  {
    id: 'workspace',
    displayName: 'Workspace',
    description: 'Project questions answered from your workspace files and code.',
    contextKinds: ['file', 'codebase'],
    toolPrefixes: ['project.', 'codebase.', 'files.', 'mock.'],
  },
];

/**
 * Renders a machine status as words. The value is defensive on purpose: a status
 * that never arrived must not take the whole page down.
 */
function prettyStatus(status: string | undefined): string {
  return typeof status === 'string' && status.length > 0 ? status.replace(/_/g, ' ') : 'unknown';
}

export function ReasoningPage() {
  const { toast } = useToast();
  const [capabilities, setCapabilities] = useState<api.ReasoningCapabilities | null>(null);
  const [loadingCapabilities, setLoadingCapabilities] = useState(true);
  const [capabilityError, setCapabilityError] = useState('');

  const [task, setTask] = useState('');
  const [profile, setProfile] = useState<api.ReasoningProfileId>('workspace');
  const [mode, setMode] = useState<'gateway' | 'simulated'>('gateway');

  const [run, setRun] = useState<api.ReasoningRunView | null>(null);
  const [phases, setPhases] = useState<readonly PhaseView[]>([]);
  const [streamedAnswer, setStreamedAnswer] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [runError, setRunError] = useState('');
  const [deciding, setDeciding] = useState(false);

  const closeStream = useRef<(() => void) | null>(null);
  const answerRef = useRef('');

  const loadCapabilities = useCallback(async () => {
    setLoadingCapabilities(true);
    try {
      const next = await api.getCapabilities();
      setCapabilities(next);
      setCapabilityError('');
      setMode(
        next.provider.connected
          ? 'gateway'
          : next.simulatedReasoningAllowed
            ? 'simulated'
            : 'gateway',
      );
    } catch (error) {
      setCapabilityError(errorMessage(error));
    } finally {
      setLoadingCapabilities(false);
    }
  }, []);

  useEffect(() => {
    void loadCapabilities();
    return () => {
      closeStream.current?.();
    };
  }, [loadCapabilities]);

  const profiles = capabilities?.profiles ?? PROFILE_FALLBACK;
  const selectedProfile = useMemo(
    () => profiles.find((entry) => entry.id === profile) ?? profiles[0],
    [profiles, profile],
  );

  const toolsForProfile = useMemo(() => {
    const prefixes = selectedProfile?.toolPrefixes ?? [];
    const tools = capabilities?.tools ?? [];
    if (prefixes.length === 0) return tools;
    return tools.filter((tool) => prefixes.some((prefix) => tool.id.startsWith(prefix)));
  }, [capabilities, selectedProfile]);

  /** Follows the run's own stream: phases, deltas, tools, then the final run. */
  const follow = useCallback((runId: string) => {
    closeStream.current?.();
    let sawDelta = false;
    setStreaming(true);
    closeStream.current = api.followRun(
      runId,
      (event) => {
        switch (event.type) {
          case 'phase':
            setPhases((previous) =>
              previous.at(-1)?.phase === event.phase
                ? previous
                : [
                    ...previous,
                    { phase: event.phase, ...(event.detail ? { detail: event.detail } : {}) },
                  ],
            );
            break;
          case 'delta':
            sawDelta = true;
            answerRef.current += event.text;
            setStreamedAnswer(answerRef.current);
            break;
          case 'tool':
            break;
          case 'final': {
            // The stream may carry the terminal run, but a run is never assumed
            // to be present: fetch it rather than rendering an empty screen.
            const finished = event.run;
            if (finished !== undefined) {
              setRun(finished);
              if (finished.answer !== undefined && finished.answer !== '') {
                answerRef.current = finished.answer;
                setStreamedAnswer(finished.answer);
              }
            } else {
              void api
                .getRun(runId)
                .then((fresh) => {
                  setRun(fresh);
                  if (fresh.answer !== undefined && fresh.answer !== '') {
                    answerRef.current = fresh.answer;
                    setStreamedAnswer(fresh.answer);
                  }
                })
                .catch(() => {
                  setRunError('The run finished, but its result could not be loaded.');
                });
            }
            break;
          }
          case 'usage':
            setRun((previous) =>
              previous === null ? previous : { ...previous, usage: event.usage },
            );
            break;
          case 'error':
            setRunError(event.message);
            break;
          default:
            break;
        }
      },
      () => {
        setStreaming(false);
        setRun((previous) => {
          if (previous === null) return previous;
          if (api.isTerminal(previous.status)) return previous;
          // The stream closed early: read the run so the page tells the truth.
          void api
            .getRun(previous.id)
            .then((fresh) => {
              setRun(fresh);
              if (fresh.answer !== undefined && fresh.answer !== '') {
                answerRef.current = fresh.answer;
                setStreamedAnswer(fresh.answer);
              }
            })
            .catch(() => undefined);
          return previous;
        });
        if (!sawDelta) return;
      },
    );
  }, []);

  const onStart = useCallback(async () => {
    const trimmed = task.trim();
    if (trimmed.length === 0) {
      toast('Describe what you want the assistant to do first.', { tone: 'error' });
      return;
    }
    closeStream.current?.();
    setStarting(true);
    setRunError('');
    setPhases([]);
    setStreamedAnswer('');
    answerRef.current = '';
    try {
      const started = await api.startRun({
        task: trimmed,
        profile,
        mode,
      });
      setRun(started);
      follow(started.id);
    } catch (error) {
      setRun(null);
      setRunError(errorMessage(error));
    } finally {
      setStarting(false);
    }
  }, [task, profile, mode, follow, toast]);

  const onCancel = useCallback(async () => {
    if (run === null) return;
    try {
      const cancelled = await api.cancelRun(run.id);
      setRun(cancelled);
      setStreaming(false);
      closeStream.current?.();
      toast('Run cancelled. Nothing further will happen.');
    } catch (error) {
      toast(errorMessage(error), { tone: 'error' });
    }
  }, [run, toast]);

  const onDecide = useCallback(
    async (decision: 'approved' | 'rejected') => {
      if (run?.pendingConfirmation === undefined) return;
      setDeciding(true);
      try {
        const resumed = await api.decide(run.id, run.pendingConfirmation.confirmationId, decision);
        setRun(resumed);
        follow(resumed.id);
        toast(
          decision === 'approved'
            ? 'Approved. The run continues.'
            : 'Rejected. The run continues without it.',
        );
      } catch (error) {
        toast(errorMessage(error), { tone: 'error' });
      } finally {
        setDeciding(false);
      }
    },
    [run, follow, toast],
  );

  const busy = starting || streaming;
  const pending = run?.pendingConfirmation;
  const answer = run?.answer ?? streamedAnswer;

  return (
    <div className="v-page v-reason">
      <header className="v-page-header">
        <div>
          <h1 className="v-page-header__title">Reasoning workspace</h1>
          <p className="v-page-header__description">
            Ask a question or set a task. The assistant plans, uses the read-only tools it is
            allowed, and shows the provider that answered.
          </p>
        </div>
        <div className="v-reason__chips">
          <Badge tone={capabilities?.provider.connected ? 'success' : 'warning'}>
            {capabilities?.provider.connected ? 'Provider connected' : 'No provider'}
          </Badge>
          {run?.provider !== undefined && (
            <>
              <Badge tone="neutral">{run.provider.providerId}</Badge>
              <Badge tone="neutral">{run.provider.modelId}</Badge>
              <Badge tone={run.provider.simulated ? 'warning' : 'success'}>
                {run.provider.simulated ? 'Simulated' : 'Live model'}
              </Badge>
            </>
          )}
        </div>
      </header>

      {capabilityError !== '' && (
        <Card>
          <p className="v-reason__error" role="alert">
            {capabilityError}
          </p>
          <Button variant="secondary" onClick={() => void loadCapabilities()}>
            Try again
          </Button>
        </Card>
      )}

      <Card>
        <div className="v-reason__form">
          <div className="v-reason__row">
            <label className="v-reason__field">
              <span className="v-reason__label">Profile</span>
              <Select
                aria-label="Reasoning profile"
                value={profile}
                onChange={(event) => setProfile(event.target.value as api.ReasoningProfileId)}
                options={profiles.map((entry) => ({ value: entry.id, label: entry.displayName }))}
                disabled={busy}
              />
            </label>
            <label className="v-reason__field">
              <span className="v-reason__label">Model source</span>
              <Select
                aria-label="Model source"
                value={mode}
                onChange={(event) => setMode(event.target.value as 'gateway' | 'simulated')}
                options={[
                  {
                    value: 'gateway',
                    label: 'Your connected provider',
                    disabled: capabilities !== null && !capabilities.provider.connected,
                  },
                  {
                    value: 'simulated',
                    label: 'Simulated (no model)',
                    disabled: capabilities !== null && !capabilities.simulatedReasoningAllowed,
                  },
                ]}
                disabled={busy}
              />
            </label>
          </div>

          {selectedProfile !== undefined && (
            <p className="v-reason__hint">{selectedProfile.description}</p>
          )}

          <Textarea
            aria-label="Task"
            value={task}
            onChange={(event) => setTask(event.target.value)}
            rows={3}
            placeholder="For example: summarise what this project does and list its open gaps."
            disabled={busy}
          />

          <div className="v-reason__actions">
            <Button onClick={() => void onStart()} disabled={busy || task.trim().length === 0}>
              {busy ? 'Working…' : 'Run reasoning'}
            </Button>
            {run !== null && !api.isTerminal(run.status) && (
              <Button variant="secondary" onClick={() => void onCancel()} disabled={starting}>
                Cancel run
              </Button>
            )}
            {capabilities === null && loadingCapabilities && (
              <Spinner size="sm" aria-label="Loading reasoning options" />
            )}
          </div>

          {capabilities !== null && !capabilities.provider.connected && (
            <p className="v-reason__hint" role="note">
              {capabilities.provider.reason ??
                'Connect an AI provider in Settings to reason on your own model.'}{' '}
              A simulated run shows how the loop behaves without calling a model.
            </p>
          )}
        </div>
      </Card>

      {runError !== '' && (
        <Card>
          <p className="v-reason__error" role="alert">
            {runError}
          </p>
        </Card>
      )}

      {run !== null && (
        <div className="v-reason__grid">
          <Card>
            <h2 className="v-reason__heading">Run</h2>
            <div className="v-reason__phase-strip" aria-label="Phases">
              {phases.length === 0 && (
                <span className="v-reason__muted">Waiting for the first phase…</span>
              )}
              {phases.map((entry, index) => (
                <span className="v-reason__phase" key={`${entry.phase}-${index}`}>
                  <span className="v-reason__phase-dot" aria-hidden="true" />
                  {PHASE_LABELS[entry.phase] ?? entry.phase}
                </span>
              ))}
            </div>
            <p className="v-reason__status">
              Status: <strong>{prettyStatus(run.status)}</strong>
              {streaming && <span className="v-reason__live"> · streaming</span>}
            </p>
            {run.classification !== undefined && (
              <p className="v-reason__muted">
                Classified as {run.classification.taskType}
                {run.classification.needsTools ? ', needs tools' : ', no tools needed'}.
              </p>
            )}
            {run.plan !== undefined && (
              <div>
                <h3 className="v-reason__subheading">Plan</h3>
                <ol className="v-reason__plan">
                  {run.plan.steps.map((step, index) => (
                    <li key={`${step.intent}-${index}`}>{step.intent}</li>
                  ))}
                </ol>
              </div>
            )}
          </Card>

          <Card>
            <h2 className="v-reason__heading">Answer</h2>
            {answer !== undefined && answer !== '' ? (
              <div className="v-reason__answer" aria-live="polite">
                {answer}
              </div>
            ) : run.status === 'failed' ? (
              <p className="v-reason__error" role="alert">
                {run.error?.message ?? 'The run failed before it produced an answer.'}
              </p>
            ) : run.status === 'cancelled' ? (
              <p className="v-reason__muted">This run was cancelled, so there is no answer.</p>
            ) : (
              <p className="v-reason__muted">No answer yet.</p>
            )}

            {run.steps.length > 0 && (
              <div>
                <h3 className="v-reason__subheading">Tool activity</h3>
                <ul className="v-reason__tools">
                  {run.steps.map((step) => (
                    <li key={step.id} className="v-reason__tool">
                      <Badge
                        tone={
                          step.status === 'success'
                            ? 'success'
                            : step.status === 'pending_confirmation'
                              ? 'warning'
                              : 'error'
                        }
                      >
                        {prettyStatus(step.status)}
                      </Badge>
                      <span className="v-reason__tool-name">{step.toolId}</span>
                      <span className="v-reason__muted">{step.intent}</span>
                      {step.error !== undefined && (
                        <span className="v-reason__error">{step.error.message}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {run.limitations.length > 0 && (
              <p className="v-reason__muted">
                What this run cannot promise: {run.limitations.join(' ')}
              </p>
            )}

            <p className="v-reason__muted">
              {run.usage.iterations} iteration{run.usage.iterations === 1 ? '' : 's'} ·{' '}
              {run.usage.toolCalls} tool call{run.usage.toolCalls === 1 ? '' : 's'} ·{' '}
              {run.usage.inputTokens === null
                ? 'token counts unavailable'
                : `${run.usage.inputTokens} in / ${run.usage.outputTokens ?? 0} out`}{' '}
              · {Math.round(run.usage.latencyMs / 100) / 10}s
            </p>
          </Card>
        </div>
      )}

      {pending !== undefined && (
        <Card>
          <h2 className="v-reason__heading">Waiting for your decision</h2>
          <p className="v-reason__muted">
            The run stopped before calling <strong>{pending.toolId}</strong>
            {pending.riskLevel !== undefined ? ` (${pending.riskLevel} risk)` : ''}. Nothing has run
            yet.
          </p>
          <div className="v-reason__actions">
            <Button onClick={() => void onDecide('approved')} disabled={deciding}>
              Approve
            </Button>
            <Button
              variant="secondary"
              onClick={() => void onDecide('rejected')}
              disabled={deciding}
            >
              Reject
            </Button>
          </div>
        </Card>
      )}

      <Card>
        <h2 className="v-reason__heading">Tools on offer</h2>
        <p className="v-reason__muted">
          The assistant may only name these, and every one is read-only for this profile.
        </p>
        {toolsForProfile.length === 0 ? (
          <p className="v-reason__muted">This build offers no tools for that profile.</p>
        ) : (
          <ul className="v-reason__tools">
            {toolsForProfile.map((tool) => (
              <li key={tool.id} className="v-reason__tool">
                <Badge tone={tool.available ? 'success' : 'warning'}>
                  {tool.available ? 'available' : 'unavailable'}
                </Badge>
                <span className="v-reason__tool-name">{tool.name}</span>
                <span className="v-reason__muted">
                  {tool.category} · {tool.riskLevel} risk
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
