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
}

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
        <h2 className="v-fbuilder__panel-title">AI builder</h2>
        <Badge tone={capabilities?.decisionSource === 'injected' ? 'success' : 'neutral'}>
          {capabilities === null
            ? 'agent status unknown'
            : capabilities.decisionSource === 'injected'
              ? 'connected model'
              : 'scripted demo agent'}
        </Badge>
      </header>

      {capabilities?.decisionSource === 'scripted-demo' && (
        <p className="v-fbuilder__note" role="note">
          This build runs the coding agent on a deterministic script, so its plan may not match your
          wording. The approval gate, revision checks and file writes are real.
        </p>
      )}

      <div className="v-fbuilder__messages" role="log" aria-live="polite" aria-label="Conversation">
        {messages.length === 0 && (
          <EmptyState
            title="Describe what you want to build"
            description="Requests become a bounded coding run: plan, your approval, then real file changes."
          />
        )}
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
            </span>
          </div>

          {run.state === 'failed' && run.failure !== null && (
            <p className="v-fbuilder__error" role="alert">
              {run.failure.message}
            </p>
          )}

          {awaiting?.kind === 'plan_approval' && run.plan !== null && (
            <div className="v-fbuilder__review" data-testid="plan-review">
              <h3 className="v-fbuilder__review-title">Review the plan</h3>
              <p className="v-fbuilder__review-goal">{run.plan.goal}</p>
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
              {run.plan.filesToInspect.length > 0 && (
                <p className="v-fbuilder__review-files">
                  <span className="v-fbuilder__review-label">Will read:</span>{' '}
                  {run.plan.filesToInspect.join(', ')}
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
                Show changes in the explorer
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
          label="What should the builder do?"
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
            Send request
          </Button>
        </div>
        {messages.length === 0 && (
          <ul className="v-fbuilder__suggestions" aria-label="Example requests">
            {SUGGESTIONS.map((suggestion) => (
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
