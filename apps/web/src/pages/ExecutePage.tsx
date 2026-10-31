import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Input, Select, Spinner, Textarea, useToast } from '../components/ui';
import { errorMessage } from '../api/client';
import * as api from '../api/ai-execution';

/**
 * Model runs (Step 29).
 *
 * The direct surface for a single model call. Everything the platform promises
 * is visible here: which model the router chose and why, the answer as it
 * streams, what the provider reported for tokens (or that it reported nothing),
 * whether a cost is a declared price or unknown, and a cancel that actually
 * cancels.
 */

const CATEGORIES = [
  'general-conversation',
  'complex-reasoning',
  'coding',
  'document-analysis',
  'cross-source-intelligence',
  'web-research',
  'structured-data-extraction',
] as const;

type RunStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';

function label(value: string): string {
  return value.replace(/-/g, ' ');
}

function tokensLine(usage: api.UsageReported): string {
  if (usage.totalTokens === null) {
    return 'The provider did not report token counts for this run.';
  }
  return `${usage.inputTokens ?? 0} in · ${usage.outputTokens ?? 0} out · ${usage.totalTokens} total`;
}

function costLine(usage: api.UsageReported): string {
  if (usage.costSource === 'declared-pricing' && usage.estimatedCostUsd !== null) {
    return `Estimated $${usage.estimatedCostUsd.toFixed(4)} at the price declared for this model.`;
  }
  return 'No price is declared for this model, so no cost is shown.';
}

export function ExecutePage() {
  const { toast } = useToast();
  const [capabilities, setCapabilities] = useState<api.ExecutionCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState('');

  const [task, setTask] = useState('');
  const [category, setCategory] = useState<string>('general-conversation');
  const [maxTokens, setMaxTokens] = useState('1024');

  const [status, setStatus] = useState<RunStatus>('idle');
  const [runId, setRunId] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [stage, setStage] = useState('');
  const [route, setRoute] = useState<api.RouteSelected | null>(null);
  const [context, setContext] = useState<api.ContextPrepared | null>(null);
  const [usage, setUsage] = useState<api.UsageReported | null>(null);
  const [runError, setRunError] = useState('');

  const [history, setHistory] = useState<readonly api.UsageRow[]>([]);
  const [historyError, setHistoryError] = useState('');

  const abortRef = useRef<AbortController | null>(null);
  const answerRef = useRef('');

  const loadCapabilities = useCallback(async () => {
    setCapabilityError('');
    try {
      setCapabilities(await api.getExecutionCapabilities());
    } catch (error) {
      setCapabilityError(errorMessage(error));
    }
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryError('');
    try {
      setHistory(await api.getExecutionUsage(10));
    } catch (error) {
      setHistoryError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void loadCapabilities();
    void loadHistory();
  }, [loadCapabilities, loadHistory]);

  const onRun = useCallback(async () => {
    const trimmed = task.trim();
    if (trimmed.length === 0) {
      toast('Write the task you want the model to do first.', { tone: 'error' });
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStatus('running');
    setAnswer('');
    answerRef.current = '';
    setRoute(null);
    setContext(null);
    setUsage(null);
    setRunError('');
    setStage('Starting');
    setRunId(null);

    const parsedMax = Number(maxTokens);
    try {
      await api.startExecution(
        {
          task: trimmed,
          category,
          stream: true,
          ...(Number.isFinite(parsedMax) && parsedMax > 0
            ? { maxOutputTokens: Math.trunc(parsedMax) }
            : {}),
        },
        {
          onRunId: (id) => setRunId(id),
          onEvent: (event) => {
            switch (event.type) {
              case 'progress':
                setStage(event.message);
                break;
              case 'route.selected':
                setRoute(event);
                break;
              case 'context.prepared':
                setContext(event);
                break;
              case 'delta':
                answerRef.current += event.text;
                setAnswer(answerRef.current);
                break;
              case 'usage':
                setUsage(event);
                break;
              case 'run.completed':
                if (event.content.length > 0) {
                  answerRef.current = event.content;
                  setAnswer(event.content);
                }
                setStatus('completed');
                setStage('');
                void loadHistory();
                break;
              case 'run.failed':
                setStatus('failed');
                setRunError(event.message);
                setStage('');
                break;
              case 'run.cancelled':
                setStatus('cancelled');
                setRunError(event.message);
                setStage('');
                break;
              default:
                break;
            }
          },
        },
        { signal: controller.signal },
      );
    } catch (error) {
      if (controller.signal.aborted) {
        setStatus('cancelled');
        setRunError('The run was stopped in this tab.');
        return;
      }
      setStatus('failed');
      setRunError(errorMessage(error));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [task, category, maxTokens, toast, loadHistory]);

  const onCancel = useCallback(async () => {
    abortRef.current?.abort();
    if (runId === null) {
      setStatus('cancelled');
      setRunError('Stopped before the run started.');
      return;
    }
    try {
      await api.cancelExecutionRun(runId);
      toast('Run cancelled. Nothing further will be generated.');
    } catch (error) {
      toast(errorMessage(error), { tone: 'error' });
    }
  }, [runId, toast]);

  const running = status === 'running';

  return (
    <div className="v-page v-execute">
      <header className="v-page-header">
        <div>
          <h1 className="v-page-header__title">Model runs</h1>
          <p className="v-page-header__description">
            Send one task to a model. The platform picks the model, streams the answer, and shows
            what the provider reported. Nothing is charged twice for the same run.
          </p>
        </div>
        <div className="v-execute__chips">
          <Badge tone={capabilities?.ready ? 'success' : 'warning'}>
            {capabilities?.ready ? 'Ready' : 'No provider'}
          </Badge>
          {route !== null && (
            <>
              <Badge tone="neutral">{route.providerName}</Badge>
              <Badge tone="neutral">{route.modelId}</Badge>
              <Badge tone={route.streaming ? 'success' : 'warning'}>
                {route.streaming ? 'Streaming' : 'One piece'}
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

      {capabilities !== null && !capabilities.ready && (
        <Card>
          <p className="v-reason__hint" role="note">
            {capabilities.blockedReason ?? 'Connect an AI provider in Settings to run a model.'}
          </p>
        </Card>
      )}

      <Card>
        <h2 className="v-reason__heading">Task</h2>
        <div className="v-reason__form">
          <div className="v-reason__row">
            <label className="v-reason__field">
              <span className="v-reason__label">Task type</span>
              <Select
                value={category}
                options={CATEGORIES.map((value) => ({ value, label: label(value) }))}
                onChange={(event) => setCategory(event.target.value)}
              />
            </label>
            <label className="v-reason__field">
              <span className="v-reason__label">Answer budget (tokens)</span>
              <Input
                value={maxTokens}
                inputMode="numeric"
                onChange={(event) => setMaxTokens(event.target.value)}
              />
            </label>
          </div>
          <label className="v-reason__field">
            <span className="v-reason__label">What should the model do?</span>
            <Textarea
              value={task}
              rows={4}
              placeholder="Explain why a cached layer would help this endpoint."
              onChange={(event) => setTask(event.target.value)}
            />
          </label>
          <div className="v-reason__actions">
            <Button onClick={() => void onRun()} disabled={running}>
              {running ? 'Running…' : 'Run'}
            </Button>
            {running && (
              <Button variant="secondary" onClick={() => void onCancel()}>
                Stop
              </Button>
            )}
            {running && <Spinner />}
          </div>
          {stage !== '' && (
            <p className="v-reason__muted" role="status">
              {stage}
            </p>
          )}
        </div>
      </Card>

      {runError !== '' && (
        <Card>
          <p className="v-reason__error" role="alert">
            {runError}
          </p>
          <p className="v-reason__muted">
            {status === 'cancelled'
              ? 'A cancelled run keeps whatever arrived before it stopped.'
              : 'Nothing was substituted for the answer you asked for.'}
          </p>
        </Card>
      )}

      {(route !== null || context !== null || answer !== '') && (
        <div className="v-reason__grid">
          <Card>
            <h2 className="v-reason__heading">Answer</h2>
            {answer === '' ? (
              <p className="v-reason__muted">No text has arrived yet.</p>
            ) : (
              <p className="v-execute__answer" data-testid="execute-answer">
                {answer}
              </p>
            )}
            {status === 'cancelled' && (
              <p className="v-reason__muted">This answer was cut short by the cancel.</p>
            )}
          </Card>

          <Card>
            <h2 className="v-reason__heading">Route</h2>
            {route === null ? (
              <p className="v-reason__muted">The model has not been chosen yet.</p>
            ) : (
              <>
                <p className="v-reason__muted" data-testid="execute-route">
                  {route.providerName} · {route.modelId}
                </p>
                <p className="v-reason__hint">{route.summary}</p>
                <p className="v-reason__muted">
                  {route.contextWindowTokens === null
                    ? 'This model declares no context window.'
                    : `Context window: ${route.contextWindowTokens.toLocaleString()} tokens.`}
                </p>
              </>
            )}
            {context !== null && (
              <p className="v-reason__muted">
                {context.truncated
                  ? `${context.droppedMessages} earlier message(s) were left out to fit the window.`
                  : 'The whole prompt fitted the window.'}
              </p>
            )}
          </Card>

          <Card>
            <h2 className="v-reason__heading">Usage</h2>
            {usage === null ? (
              <p className="v-reason__muted">
                {running ? 'Waiting for the provider to report usage.' : 'No usage reported yet.'}
              </p>
            ) : (
              <>
                <p className="v-reason__muted" data-testid="execute-tokens">
                  {tokensLine(usage)}
                </p>
                <p className="v-reason__muted">{costLine(usage)}</p>
                <p className="v-reason__muted">
                  {usage.latencyMs} ms · {usage.streamed ? 'streamed' : 'delivered in one piece'}
                </p>
              </>
            )}
          </Card>
        </div>
      )}

      <Card>
        <h2 className="v-reason__heading">Recent usage</h2>
        {historyError !== '' ? (
          <p className="v-reason__error" role="alert">
            {historyError}
          </p>
        ) : history.length === 0 ? (
          <p className="v-reason__muted">No runs yet. Usage appears here after the first one.</p>
        ) : (
          <ul className="v-execute__history">
            {history.map((row) => (
              <li key={row.id}>
                <span>
                  {row.providerId} · {row.modelId}
                </span>
                <span className="v-reason__muted">
                  {row.status === 'success'
                    ? `${row.totalTokens ?? '—'} tokens`
                    : `${row.status}${row.usageSource === 'unavailable' ? ' (no tokens reported)' : ''}`}
                </span>
                <span className="v-reason__muted">
                  {row.costSource === 'declared-pricing' && row.estimatedCostUsd !== null
                    ? `$${row.estimatedCostUsd.toFixed(4)}`
                    : 'cost unknown'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
