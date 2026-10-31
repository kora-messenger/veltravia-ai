import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Dialog, Input, Select } from '../components/ui';
import { errorMessage } from '../api/client';
import * as api from '../api/ai-providers';

/**
 * AI providers (Step 26). Bring-your-own-key, honestly surfaced:
 *
 * - the page can never read a key back, only the masked hint;
 * - a missing encryption key on the server is shown as a blocker, not as an
 *   empty list with no explanation;
 * - verification and every failure are reported with what actually happened;
 * - deleting a connection says plainly what stops working (nothing is silently
 *   rerouted to a shared key, because there is no shared key).
 */
export function AiProvidersPage() {
  const [overview, setOverview] = useState<api.ProvidersOverview | null>(null);
  const [usage, setUsage] = useState<readonly api.UsageRecordView[]>([]);
  const [costAvailable, setCostAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [connecting, setConnecting] = useState(false);
  const [providerId, setProviderId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [manualModels, setManualModels] = useState('');
  const [replacing, setReplacing] = useState<api.ProviderConnection | null>(null);
  const [replacementKey, setReplacementKey] = useState('');
  const [deleting, setDeleting] = useState<api.ProviderConnection | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.getProviders();
      setOverview(data);
      if (data.ready) {
        try {
          const history = await api.getUsage(20);
          setUsage(history.usage);
          setCostAvailable(history.costAvailable);
        } catch {
          // Usage is an ENHANCEMENT: a failed read must not hide the providers.
          setUsage([]);
          setCostAvailable(false);
        }
      } else {
        setUsage([]);
      }
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedProvider = useMemo(
    () => overview?.catalog.find((entry) => entry.id === providerId) ?? null,
    [overview, providerId],
  );

  const openConnect = () => {
    const first = overview?.catalog[0]?.id ?? '';
    setProviderId(first);
    setApiKey('');
    setDisplayName('');
    setBaseUrl('');
    setManualModels('');
    setError('');
    setNotice('');
    setConnecting(true);
  };

  const submitConnect = async () => {
    if (selectedProvider === null) return;
    setBusy(true);
    setError('');
    try {
      const models = manualModels
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      await api.createConnection({
        providerId: selectedProvider.id,
        apiKey: apiKey.trim(),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(models.length > 0 ? { modelIds: models } : {}),
        ...(models.length > 0 ? { skipDiscovery: true } : {}),
      });
      setConnecting(false);
      setNotice(`${selectedProvider.displayName} connected. The key is stored encrypted.`);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (connection: api.ProviderConnection) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api.validateConnection(connection.id);
      setNotice(
        result.valid
          ? `${connection.displayName} responded. ${connection.models.length} model${
              connection.models.length === 1 ? '' : 's'
            } available.`
          : `${connection.displayName} could not be verified: ${result.message}`,
      );
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const makeDefault = async (connection: api.ProviderConnection) => {
    setBusy(true);
    setError('');
    try {
      await api.savePreferences({
        defaultConnectionId: connection.id,
        defaultModelId: connection.defaultModelId,
      });
      setNotice(`${connection.displayName} is now the default provider.`);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const setModel = async (connection: api.ProviderConnection, modelId: string) => {
    setBusy(true);
    setError('');
    try {
      await api.updateConnection(connection.id, {
        defaultModelId: modelId === '' ? null : modelId,
      });
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const submitReplacement = async () => {
    if (replacing === null) return;
    setBusy(true);
    setError('');
    try {
      await api.replaceCredential(replacing.id, replacementKey.trim());
      setReplacing(null);
      setReplacementKey('');
      setNotice(`Key replaced for ${replacing.displayName}.`);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (deleting === null) return;
    setBusy(true);
    setError('');
    try {
      await api.deleteConnection(deleting.id);
      setNotice(
        `${deleting.displayName} removed. Agents and documents will refuse to run on your provider until you connect another.`,
      );
      setDeleting(null);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="v-page">
      <header className="v-page__header">
        <h1 className="v-page__title">AI providers</h1>
        <p className="v-page__subtitle">
          Use your own model account. Keys are encrypted before they are stored, never shown again
          after saving, and never leave the server.
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

      {loading && <p className="v-connections__empty">Loading providers…</p>}

      {!loading && overview !== null && !overview.ready && (
        <section className="v-connections__card" aria-label="Encryption not configured">
          <h2 className="v-connections__card-title">Keys cannot be stored yet</h2>
          <p className="v-connections__card-text">
            {overview.blockedReason ??
              'This server has no credential encryption key configured, so nothing can be saved.'}
          </p>
          <p className="v-connections__mode">
            Nothing is stored and no provider is called until this is configured. Agents and
            documents keep using the built-in deterministic providers.
          </p>
        </section>
      )}

      {!loading && overview !== null && overview.ready && (
        <>
          <div className="v-ai__toolbar">
            <Button onClick={openConnect} disabled={busy}>
              Connect a provider
            </Button>
            <p className="v-ai__encryption">
              Stored with {overview.encryption.algorithm ?? 'an unknown scheme'}
              {overview.encryption.keyVersions.length > 0 &&
                ` · key version ${Math.max(...overview.encryption.keyVersions)}`}
            </p>
          </div>

          {overview.providers.length === 0 ? (
            <section className="v-connections__card" aria-label="No providers connected">
              <h2 className="v-connections__card-title">No provider connected</h2>
              <p className="v-connections__card-text">
                Model runs are refused until you connect one. Nothing falls back to a shared key,
                because there is none.
              </p>
            </section>
          ) : (
            <section className="v-ai__grid" aria-label="Connected providers">
              {overview.providers.map((connection) => (
                <article key={connection.id} className="v-connections__card">
                  <div className="v-connections__card-head">
                    <h2 className="v-connections__card-title">{connection.displayName}</h2>
                    <span
                      className={`v-connections__status v-connections__status--${
                        connection.status === 'active' ? 'connected' : 'idle'
                      }`}
                    >
                      {connection.status === 'active' ? 'Active' : 'Disabled'}
                    </span>
                  </div>
                  <p className="v-connections__card-text">
                    {connection.providerName} · key {connection.credentialHint}
                    {connection.isDefault && ' · default'}
                  </p>
                  {connection.baseUrl !== null && (
                    <p className="v-connections__mode">Endpoint: {connection.baseUrl}</p>
                  )}
                  <p className="v-connections__mode">
                    {connection.lastValidatedAt
                      ? `Verified ${new Date(connection.lastValidatedAt).toLocaleString()}`
                      : 'Not verified since it was saved'}
                    {connection.lastErrorCategory !== null &&
                      ` · last error: ${connection.lastErrorCategory}`}
                  </p>

                  <div className="v-ai__field">
                    <Select
                      label={`Default model for ${connection.displayName}`}
                      value={connection.defaultModelId ?? ''}
                      onChange={(event) => void setModel(connection, event.target.value)}
                      disabled={busy}
                      options={[
                        { value: '', label: 'No default model' },
                        ...connection.modelIds.map((modelId) => ({
                          value: modelId,
                          label: modelId,
                        })),
                      ]}
                    />
                  </div>

                  <div className="v-connections__actions">
                    <Button
                      variant="secondary"
                      onClick={() => void verify(connection)}
                      disabled={busy}
                    >
                      Verify
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setReplacing(connection);
                        setReplacementKey('');
                      }}
                      disabled={busy}
                    >
                      Replace key
                    </Button>
                    {!connection.isDefault && (
                      <Button onClick={() => void makeDefault(connection)} disabled={busy}>
                        Make default
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      onClick={() => setDeleting(connection)}
                      disabled={busy}
                    >
                      Remove
                    </Button>
                  </div>
                </article>
              ))}
            </section>
          )}

          <section className="v-connections__card" aria-label="Recent model usage">
            <h2 className="v-connections__card-title">Recent usage</h2>
            {usage.length === 0 ? (
              <p className="v-connections__empty">
                No model calls yet. Usage appears here after a run, with no prompt or answer
                content.
              </p>
            ) : (
              <>
                <table className="v-ai__table">
                  <caption className="v-ai__caption">
                    Latest {usage.length} calls{!costAvailable && ' · cost not estimated'}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Provider</th>
                      <th scope="col">Model</th>
                      <th scope="col">Status</th>
                      <th scope="col">Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.map((record) => (
                      <tr key={record.id}>
                        <td>{new Date(record.requestedAt).toLocaleString()}</td>
                        <td>{record.providerId}</td>
                        <td>{record.modelId}</td>
                        <td>
                          {record.status === 'success'
                            ? record.live
                              ? 'Success (live)'
                              : 'Success'
                            : `Failed${record.errorCategory ? ` (${record.errorCategory})` : ''}`}
                        </td>
                        <td>
                          {record.inputTokens === null && record.outputTokens === null
                            ? 'Not reported'
                            : `${record.inputTokens ?? '?'} in / ${record.outputTokens ?? '?'} out`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>
        </>
      )}

      <Dialog
        open={connecting}
        title="Connect a provider"
        onClose={() => setConnecting(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConnecting(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={() => void submitConnect()}
              disabled={busy || apiKey.trim().length === 0}
            >
              Save key
            </Button>
          </>
        }
      >
        <div className="v-ai__form">
          <Select
            label="Provider"
            value={providerId}
            onChange={(event) => setProviderId(event.target.value)}
            options={(overview?.catalog ?? []).map((entry) => ({
              value: entry.id,
              label: entry.displayName,
            }))}
          />
          {selectedProvider !== null && (
            <p className="v-connections__mode">
              {selectedProvider.description}
              {selectedProvider.docsUrl !== null && (
                <>
                  {' '}
                  <a href={selectedProvider.docsUrl} target="_blank" rel="noreferrer">
                    Where to get a key
                  </a>
                </>
              )}
            </p>
          )}
          <Input
            label="API key"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="paste the key once; it cannot be read back"
          />
          <Input
            label="Label (optional)"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Work account"
          />
          {selectedProvider?.allowsCustomBaseUrl === true && (
            <Input
              label="Endpoint URL"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://your-endpoint.example.com/v1"
            />
          )}
          <Input
            label="Models (optional, comma separated)"
            value={manualModels}
            onChange={(event) => setManualModels(event.target.value)}
            placeholder="leave blank to discover them from the provider"
          />
        </div>
      </Dialog>

      <Dialog
        open={replacing !== null}
        title="Replace key"
        onClose={() => setReplacing(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setReplacing(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={() => void submitReplacement()}
              disabled={busy || replacementKey.trim().length === 0}
            >
              Replace
            </Button>
          </>
        }
      >
        <p className="v-connections__card-text">
          The new key replaces the stored one for {replacing?.displayName ?? 'this provider'}. The
          old key is discarded.
        </p>
        <Input
          label="New API key"
          type="password"
          value={replacementKey}
          onChange={(event) => setReplacementKey(event.target.value)}
        />
      </Dialog>

      <Dialog
        open={deleting !== null}
        title="Remove provider"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleting(null)} disabled={busy}>
              Keep it
            </Button>
            <Button onClick={() => void confirmDelete()} disabled={busy}>
              Remove
            </Button>
          </>
        }
      >
        <p className="v-connections__card-text">
          {deleting?.displayName ?? 'This connection'} and its storage key are removed. Runs that
          need a model will refuse until another provider is connected.
        </p>
      </Dialog>
    </div>
  );
}
