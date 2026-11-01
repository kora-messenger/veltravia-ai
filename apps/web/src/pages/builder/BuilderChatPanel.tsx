import { useMemo, useState } from 'react';
import { Badge, Button, EmptyState, Spinner, Textarea } from '../../components/ui';
import type { CodingRunView, CodingCapabilities } from '../../api/coding';
import type { FileHistoryEntry } from '../../api/source';

/**
 * The AI builder conversation (Step 32).
 *
 * This panel is a conversation with the EXISTING coding agent, not a second
 * generation engine: every request becomes a bounded run, the plan is a human
 * gate, and the file changes are whatever the run actually recorded. It never
 * claims a model is behind the plan when the API reports a scripted source.
 */

export interface ChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly text: string;
  readonly detail?: readonly string[];
}

interface BuilderChatPanelProps {
  readonly run: CodingRunView | null;
  readonly busy: boolean;
  readonly error: string;
  readonly decisionsPending: boolean;
  readonly capabilities: CodingCapabilities | null;
  readonly messages: readonly ChatMessage[];
  readonly history: readonly FileHistoryEntry[];
  readonly onSend: (requirement: string) => void;
  readonly onDecide: (decision: 'approve' | 'reject') => void;
  readonly onCancel: () => void;
  readonly onReviewChanges: () => void;
  /**
   * Step 33: the backend workspace reuses this conversation. Only the copy
   * changes - the run, approval and cancellation paths are the same objects.
   */
  readonly heading?: string;
  readonly emptyTitle?: string;
  readonly emptyDescription?: string;
  readonly placeholder?: string;
  readonly submitLabel?: string;
  readonly suggestions?: readonly string[];
  readonly reviewChangesLabel?: string;
}

const PHASE_WORDS: Record<string, string> = {
  understanding: 'understanding the request',
  inspecting: 'reading files',
  planning: 'drafting a plan',
  awaiting_approval: 'waiting for your approval',
  applying: 'writing changes',
  validating: 'running checks',
  diagnosing: 'reading the failure',
  correcting: 'correcting the change',
  completed: 'finished',
  failed: 'stopped',
  cancelled: 'cancelled',
};

const STATE_WORDS: Record<string, string> = {
  idle: 'Getting ready',
  analyzing: 'Reading the project',
  planning: 'Drafting a plan',
  awaiting_approval: 'Waiting for your approval',
  inspecting: 'Inspecting files',
  editing: 'Writing changes',
  validating: 'Validating',
  iterating: 'Revising after validation',
  completed: 'Finished',
  failed: 'Stopped with an error',
  cancelled: 'Cancelled',
};

const SUGGESTIONS: readonly string[] = [
  'Build a landing page with a hero and pricing section',
  'Add a responsive dashboard page',
  'Create a reusable navigation component',
  'Add a login page that matches the existing design',
];

export function BuilderChatPanel({
  run,
  busy,
  error,
  decisionsPending,
  capabilities,
  messages,
  history,
  onSend,
  onDecide,
  onCancel,
  onReviewChanges,
  heading = 'AI builder',
  emptyTitle = 'Describe what you want to build',
  emptyDescription = 'Requests become a bounded coding run: plan, your approval, then real file changes.',
  placeholder = 'What should the builder do?',
  submitLabel = 'Send request',
  suggestions = SUGGESTIONS,
  reviewChangesLabel = 'Show changes in the explorer',
}: BuilderChatPanelProps) {
  const [draft, setDraft] = useState('');
  const trimmed = draft.trim();
  const awaiting = run?.pendingApproval ?? null;

  const changedKinds = useMemo(() => {
    const kinds = new Map<string, FileHistoryEntry['changeKind']>();
    for (const entry of history) {
      if (!kinds.has(entry.path)) kinds.set(entry.path, entry.changeKind);
    }
    return kinds;
  }, [history]);

  const submit = () => {
    if (trimmed.length === 0 || busy) return;
    onSend(trimmed);
    setDraft('');
  };

  return (
    <section className="v-fbuilder__panel v-fbuilder__chat" aria-label="AI builder conversation">
      <header className="v-fbuilder__panel-head">
        <h2 className="v-fbuilder__panel-title">{heading}</h2>
        <Badge
          tone={
            capabilities?.decisionSource === 'model' || capabilities?.decisionSource === 'injected'
              ? 'success'
              : 'neutral'
          }
        >
          {capabilities === null
            ? 'agent status unknown'
            : capabilities.decisionSource === 'model' || capabilities.decisionSource === 'injected'
              ? 'connected model'
              : capabilities.decisionSource === 'unavailable'
                ? 'no model connected'
                : 'scripted demo agent'}
        </Badge>
      </header>

      {capabilities?.decisionSource === 'unavailable' && (
        <p className="v-fbuilder__note" role="note" data-testid="model-unavailable">
          {capabilities.unavailableReason ??
            'No AI provider is connected yet, so no model can plan a change.'}{' '}
          Connect one in Settings, AI providers. Nothing here is simulated in the meantime.
        </p>
      )}

      {capabilities?.decisionSource === 'scripted-demo' && (
        <p className="v-fbuilder__note" role="note">
          This build runs the coding agent on a deterministic script, so its plan may not match your
          wording. The approval gate, revision checks and file writes are real.
        </p>
      )}

      <div className="v-fbuilder__messages" role="log" aria-live="polite" aria-label="Conversation">
        {messages.length === 0 && <EmptyState title={emptyTitle} description={emptyDescription} />}
        {messages.map((message) => (
          <article
            key={message.id}
            className={`v-fbuilder__message v-fbuilder__message--${message.role}`}
          >
            <p className="v-fbuilder__message-role">
              {message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Builder' : 'Note'}
            </p>
            <p className="v-fbuilder__message-text">{message.text}</p>
            {message.detail !== undefined && message.detail.length > 0 && (
              <ul className="v-fbuilder__message-detail">
                {message.detail.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </article>
        ))}
      </div>

      {run !== null && (
        <div className="v-fbuilder__run" data-testid="run-status">
          <div className="v-fbuilder__run-head">
            <strong>{STATE_WORDS[run.state] ?? run.state}</strong>
            {busy && !awaiting && <Spinner size="sm" aria-label="Run in progress" />}
            <span className="v-fbuilder__run-meta">
              {run.toolCalls} tool calls · {run.changedFiles.length} files changed
              {run.validationResults.length > 0
                ? ` · ${run.validationResults.filter((entry) => entry.passed).length}/${run.validationResults.length} checks passed`
                : ''}
            </span>
          </div>

          {run.phase !== null && run.phase !== run.state && (
            <p className="v-fbuilder__phase" data-testid="run-phase">
              Step: {PHASE_WORDS[run.phase] ?? run.phase.replace(/_/g, ' ')}
            </p>
          )}

          {run.plan !== null && run.plan.origin !== 'unknown' && (
            <p className="v-fbuilder__provenance" data-testid="plan-provenance">
              {run.plan.origin === 'model'
                ? `Planned by ${run.model?.providerName ?? run.model?.providerId ?? 'a model'}${
                    run.model?.modelId !== null && run.model?.modelId !== undefined
                      ? ` · ${run.model.modelId}`
                      : ''
                  }`
                : 'Planned by the offline script (no model was called)'}
            </p>
          )}

          {run.state === 'failed' && run.failure !== null && (
            <p className="v-fbuilder__error" role="alert">
              {run.failure.message}
            </p>
          )}

          {awaiting?.kind === 'plan_approval' && run.plan !== null && (
            <div className="v-fbuilder__review" data-testid="plan-review">
              <h3 className="v-fbuilder__review-title">Review the plan</h3>
              <p className="v-fbuilder__review-goal">{run.plan.goal}</p>
              {run.plan.requestSummary !== null && (
                <p className="v-fbuilder__review-files">
                  <span className="v-fbuilder__review-label">Understood as:</span>{' '}
                  {run.plan.requestSummary}
                </p>
              )}
              {run.plan.projectUnderstanding !== null && (
                <p className="v-fbuilder__review-files">
                  <span className="v-fbuilder__review-label">Project:</span>{' '}
                  {run.plan.projectUnderstanding}
                </p>
              )}
              {run.plan.approach !== null && (
                <p className="v-fbuilder__review-files">
                  <span className="v-fbuilder__review-label">Approach:</span> {run.plan.approach}
                </p>
              )}
              {run.plan.steps.length > 0 && (
                <ol className="v-fbuilder__review-list">
                  {run.plan.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              )}
              {run.plan.filesToModify.length > 0 && (
                <p className="v-fbuilder__review-files">
                  <span className="v-fbuilder__review-label">Intended files:</span>{' '}
                  {run.plan.filesToModify.join(', ')}
                </p>
              )}
              {run.plan.filesToCreate.length > 0 && (
                <p className="v-fbuilder__review-files">
                  <span className="v-fbuilder__review-label">Will create:</span>{' '}
                  {run.plan.filesToCreate.join(', ')}
                </p>
              )}
              {run.plan.filesToDelete.length > 0 && (
                <p className="v-fbuilder__review-files">
                  <span className="v-fbuilder__review-label">Will delete:</span>{' '}
                  {run.plan.filesToDelete.join(', ')}
                </p>
              )}
              {run.plan.filesToInspect.length > 0 && (
                <p className="v-fbuilder__review-files">
                  <span className="v-fbuilder__review-label">Will read:</span>{' '}
                  {run.plan.filesToInspect.join(', ')}
                </p>
              )}
              {run.plan.risks.length > 0 && (
                <div className="v-fbuilder__review-risks" data-testid="plan-risks">
                  <span className="v-fbuilder__review-label">Risks the plan names:</span>
                  <ul className="v-fbuilder__review-list">
                    {run.plan.risks.map((risk) => (
                      <li key={risk}>{risk}</li>
                    ))}
                  </ul>
                </div>
              )}
              {(run.plan.validationStrategy.length > 0 || run.plan.validations.length > 0) && (
                <p className="v-fbuilder__review-files">
                  <span className="v-fbuilder__review-label">How it will check the work:</span>{' '}
                  {(run.plan.validationStrategy.length > 0
                    ? run.plan.validationStrategy
                    : run.plan.validations
                  ).join(' · ')}
                </p>
              )}
              <p className="v-fbuilder__note">
                Exact contents are recorded after the run. Approving lets the agent write these
                files through the coding agent and native source storage.
              </p>
              <div className="v-fbuilder__review-actions">
                <Button
                  onClick={() => onDecide('approve')}
                  loading={decisionsPending}
                  disabled={decisionsPending}
                >
                  Approve plan
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => onDecide('reject')}
                  disabled={decisionsPending}
                >
                  Reject
                </Button>
              </div>
            </div>
          )}

          {awaiting?.kind === 'tool_confirmation' && (
            <div className="v-fbuilder__review" data-testid="tool-confirmation">
              <h3 className="v-fbuilder__review-title">Approval needed</h3>
              <p className="v-fbuilder__review-goal">
                The agent wants to run <code>{awaiting.toolId}</code>, which needs a human decision.
              </p>
              <div className="v-fbuilder__review-actions">
                <Button onClick={() => onDecide('approve')} loading={decisionsPending}>
                  Allow this step
                </Button>
                <Button variant="secondary" onClick={() => onDecide('reject')}>
                  Do not allow
                </Button>
              </div>
            </div>
          )}

          {run.validationResults.length > 0 && (
            <ul className="v-fbuilder__validation" data-testid="run-validations">
              {run.validationResults.map((entry, index) => (
                <li key={`${entry.command}-${index}`}>
                  <code>{entry.command}</code>{' '}
                  <span className="v-fbuilder__kind">
                    {entry.timedOut
                      ? 'timed out'
                      : entry.passed
                        ? 'passed'
                        : `failed${entry.exitCode === null ? '' : ` (exit ${entry.exitCode})`}`}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {run.state === 'completed' && (
            <div className="v-fbuilder__changes" data-testid="run-changes">
              <h3 className="v-fbuilder__review-title">Changes recorded</h3>
              {run.summary !== null && <p>{run.summary}</p>}
              <ul className="v-fbuilder__review-list">
                {run.changedFiles.map((path) => (
                  <li key={path}>
                    <code>{path}</code>{' '}
                    <span className="v-fbuilder__kind">{changedKinds.get(path) ?? 'changed'}</span>
                  </li>
                ))}
                {run.changedFiles.length === 0 && <li>No files were changed by this run.</li>}
              </ul>
              <Button variant="secondary" onClick={onReviewChanges}>
                {reviewChangesLabel}
              </Button>
            </div>
          )}

          {(run.state === 'editing' ||
            run.state === 'inspecting' ||
            run.state === 'validating' ||
            run.state === 'iterating' ||
            run.state === 'planning' ||
            run.state === 'analyzing' ||
            run.state === 'awaiting_approval') && (
            <Button variant="secondary" onClick={onCancel} disabled={!busy}>
              Cancel run
            </Button>
          )}
        </div>
      )}

      {error !== '' && (
        <p className="v-fbuilder__error" role="alert">
          {error}
        </p>
      )}

      <div className="v-fbuilder__composer">
        <Textarea
          label={placeholder}
          name="requirement"
          rows={3}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          hint="Plain language. The agent reads your project before changing anything."
          disabled={busy}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="v-fbuilder__composer-actions">
          <Button onClick={submit} disabled={trimmed.length === 0 || busy} loading={busy}>
            {submitLabel}
          </Button>
        </div>
        {messages.length === 0 && (
          <ul className="v-fbuilder__suggestions" aria-label="Example requests">
            {suggestions.map((suggestion) => (
              <li key={suggestion}>
                <button
                  type="button"
                  className="v-fbuilder__suggestion"
                  onClick={() => setDraft(suggestion)}
                >
                  {suggestion}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
