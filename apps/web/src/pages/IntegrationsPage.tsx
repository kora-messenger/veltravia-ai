import { useState } from 'react';
import { useAsyncResource } from '../api/use-async-resource';
import { errorMessage } from '../api/client';
import {
  checkConnectionStatus,
  createConnection,
  disableConnection,
  disconnectConnection,
  enableConnection,
  listIntegrations,
  type IntegrationView,
} from '../api/integrations';
import { Badge, Button, Checkbox, Dialog, ErrorState, Input, Spinner } from '../components/ui';

/**
 * Integrations catalog (Step 12): every integration with its declared
 * scopes, tools, risk metadata, and the owner's connections. Connections
 * are metadata only - no credential material exists on this surface, and
 * no action here executes anything: the runtime boundary lives entirely
 * server-side.
 */

interface ConnectRequest {
  readonly integration: IntegrationView;
}

export function IntegrationsPage() {
  const resource = useAsyncResource(listIntegrations, []);
  const [connectRequest, setConnectRequest] = useState<ConnectRequest | null>(null);

  const integrations = resource.state === 'ready' ? (resource.data ?? []) : [];

  return (
    <div className="v-page">
      <header className="v-page-header">
        <div>
          <h2 className="v-page-header__title">Integrations</h2>
          <p className="v-page-header__description">
            Connect external services through scoped, permission-gated integrations.
          </p>
        </div>
      </header>

      {resource.state === 'loading' && (
        <div className="v-loading" role="status">
          <Spinner size="lg" />
        </div>
      )}

      {resource.state === 'error' && (
        <ErrorState
          description={errorMessage(resource.error)}
          retry={{ onClick: resource.reload }}
        />
      )}

      {resource.state === 'ready' && integrations.length === 0 && (
        <div className="v-empty-wide">
          <div className="v-empty-wide__inner">
            <h3 className="v-heading-3">No integrations available</h3>
            <p className="v-empty-wide__hint">
              The integration catalog is empty. Integrations register on the server.
            </p>
          </div>
        </div>
      )}

      {resource.state === 'ready' && integrations.length > 0 && (
        <div className="v-integration-list">
          {integrations.map((integration) => (
            <section key={integration.id} className="v-integration" aria-labelledby="">
              <header className="v-integration__header">
                <div>
                  <h3 className="v-integration__name">{integration.name}</h3>
                  <p className="v-integration__description">{integration.description}</p>
                </div>
                <div className="v-integration__meta">
                  <Badge>{integration.category}</Badge>
                  <Badge>v{integration.version}</Badge>
                  <Badge>{integration.enabled ? 'Enabled' : 'Disabled'}</Badge>
                </div>
              </header>

              <div className="v-integration__section">
                <h4 className="v-integration__section-title">Scopes</h4>
                <ul className="v-integration__scopes">
                  {integration.scopes.map((scope) => (
                    <li key={scope.id} className="v-integration__scope">
                      <span className="v-integration__scope-id">{scope.id}</span>
                      <span className="v-integration__scope-detail">
                        {scope.description} · {scope.riskLevel} risk
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="v-integration__section">
                <h4 className="v-integration__section-title">Tools</h4>
                <ul className="v-integration__tools">
                  {integration.tools.map((tool) => (
                    <li key={tool.id} className="v-integration__tool">
                      <span className="v-integration__tool-id">{tool.id}</span>
                      <span className="v-integration__tool-detail">
                        {tool.description}
                        {tool.requiresConfirmation ? ' · requires human confirmation' : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="v-integration__section">
                <h4 className="v-integration__section-title">Connections</h4>
                {integration.connections.length === 0 ? (
                  <p className="v-integration__hint">No connections yet.</p>
                ) : (
                  <ul className="v-integration__connections">
                    {integration.connections.map((connection) => (
                      <IntegrationConnectionRow
                        key={connection.connectionId}
                        integrationId={integration.id}
                        connection={connection}
                        onChanged={resource.reload}
                      />
                    ))}
                  </ul>
                )}
                <Button
                  variant="secondary"
                  disabled={!integration.enabled}
                  onClick={() => setConnectRequest({ integration })}
                >
                  Connect
                </Button>
              </div>
            </section>
          ))}
        </div>
      )}

      <ConnectDialog
        request={connectRequest}
        onClose={() => setConnectRequest(null)}
        onConnected={() => {
          setConnectRequest(null);
          resource.reload();
        }}
      />
    </div>
  );
}

interface ConnectionRowProps {
  readonly integrationId: string;
  readonly connection: IntegrationView['connections'][number];
  onChanged(): void;
}

function IntegrationConnectionRow({ integrationId, connection, onChanged }: ConnectionRowProps) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setFailure(null);
    try {
      await action();
      onChanged();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="v-connection">
      <div className="v-connection__main">
        <span className="v-connection__ref">{connection.accountRef || 'Default connection'}</span>
        <span className="v-connection__status">
          {connection.status}
          {connection.lastStatusCheckAt !== null
            ? ` · checked ${new Date(connection.lastStatusCheckAt).toLocaleString()}`
            : ''}
        </span>
        <span className="v-connection__scopes">{connection.grantedScopes.join(', ')}</span>
      </div>
      <div className="v-connection__actions">
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void run(() => checkConnectionStatus(integrationId, connection.connectionId))
          }
        >
          Check status
        </Button>
        {connection.status === 'disabled' ? (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void run(() => enableConnection(integrationId, connection.connectionId))}
          >
            Enable
          </Button>
        ) : (
          <Button
            variant="secondary"
            disabled={busy || connection.status === 'error'}
            onClick={() =>
              void run(() => disableConnection(integrationId, connection.connectionId))
            }
          >
            Disable
          </Button>
        )}
        <Button
          variant="danger"
          disabled={busy}
          onClick={() =>
            void run(() => disconnectConnection(integrationId, connection.connectionId))
          }
        >
          Disconnect
        </Button>
      </div>
      {failure !== null && <p className="v-connection__failure">{failure}</p>}
    </li>
  );
}

interface ConnectDialogProps {
  readonly request: ConnectRequest | null;
  onClose(): void;
  onConnected(): void;
}

function ConnectDialog({ request, onClose, onConnected }: ConnectDialogProps) {
  const [selectedScopes, setSelectedScopes] = useState<readonly string[]>([]);
  const [accountRef, setAccountRef] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const open = request !== null;

  const reset = () => {
    setSelectedScopes([]);
    setAccountRef('');
    setFailure(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const toggleScope = (scopeId: string, checked: boolean) => {
    setSelectedScopes((previous) =>
      checked ? [...previous, scopeId] : previous.filter((id) => id !== scopeId),
    );
  };

  const submit = async () => {
    if (request === null || selectedScopes.length === 0) return;
    setSubmitting(true);
    setFailure(null);
    try {
      await createConnection(request.integration.id, {
        scopes: selectedScopes,
        ...(accountRef.length > 0 ? { accountRef } : {}),
      });
      reset();
      onConnected();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      title={request !== null ? `Connect ${request.integration.name}` : 'Connect'}
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={submitting || selectedScopes.length === 0}
            onClick={() => void submit()}
          >
            {submitting ? 'Connecting…' : 'Connect'}
          </Button>
        </>
      }
    >
      {request !== null && (
        <div className="v-connect-form">
          <p className="v-connect-form__hint">
            Choose the scopes this connection may use. Grants are explicit and can be revoked by
            disabling the connection.
          </p>
          <ul className="v-connect-form__scopes">
            {request.integration.scopes.map((scope) => (
              <li key={scope.id}>
                <Checkbox
                  checked={selectedScopes.includes(scope.id)}
                  onChange={(event) => toggleScope(scope.id, event.currentTarget.checked)}
                  label={`${scope.id} (${scope.riskLevel} risk)`}
                />
              </li>
            ))}
          </ul>
          <Input
            label="Account reference (optional)"
            value={accountRef}
            onChange={(event) => setAccountRef(event.target.value)}
            placeholder="A label that helps you recognize this connection"
          />
          {failure !== null && <p className="v-connect-form__failure">{failure}</p>}
        </div>
      )}
    </Dialog>
  );
}
