import { useCallback, useEffect, useState } from 'react';
import { Button, Dialog, Input } from '../components/ui';
import { errorMessage } from '../api/client';
import * as api from '../api/connections';

/** Connected Apps (Step 24). Read-only by design: the page can connect or
 *  disconnect an app and inspect what it exposes, never edit external content.
 *  Provider modes are shown honestly - a simulated provider says so. */
export function ConnectionsPage() {
  const [overview, setOverview] = useState<api.ConnectionsOverview | null>(null);
  const [health, setHealth] = useState<Record<string, api.ConnectionHealth>>({});
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [selectedScopes, setSelectedScopes] = useState<readonly string[]>([]);
  const [session, setSession] = useState<api.ConnectionSession | null>(null);
  const [resources, setResources] = useState<readonly api.ConnectedResourceView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<api.ConnectedResourceView | null>(null);
  const [content, setContent] = useState<api.ResourceContent | null>(null);
  const [analysis, setAnalysis] = useState<api.ResourceAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api.getConnections();
      setOverview(data);
      const entries = await Promise.all(
        data.connections.map(async (connection) => {
          const result = await api.getConnectionHealth(connection.providerId).catch(() => null);
          return result ? ([connection.providerId, result] as const) : null;
        }),
      );
      setHealth(Object.fromEntries(entries.filter((entry) => entry !== null)));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connectedProviders = overview?.connections ?? [];
  const openConnect = async (providerId: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    setActiveProvider(providerId);
    setContent(null);
    setAnalysis(null);
    setSelected(null);
    try {
      const created = await api.createSession(providerId);
      setSession(created);
      setSelectedScopes(created.scopes.map((scope) => scope.id));
    } catch (e) {
      setError(errorMessage(e));
      setActiveProvider(null);
    } finally {
      setBusy(false);
    }
  };

  const confirmConnect = async () => {
    if (!activeProvider) return;
    setBusy(true);
    setError('');
    try {
      await api.completeConnection(activeProvider, selectedScopes);
      setNotice(`Connected ${activeProvider.replace('_', ' ')}.`);
      setActiveProvider(null);
      setSession(null);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (providerId: string) => {
    setBusy(true);
    setError('');
    try {
      await api.disconnect(providerId);
      setNotice(`Disconnected ${providerId.replace('_', ' ')}.`);
      setResources([]);
      setSelected(null);
      setContent(null);
      setAnalysis(null);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const browse = async (providerId: string, nextCursor: string | null = null) => {
    setBusy(true);
    setError('');
    setAnalysis(null);
    try {
      const page = query.trim()
        ? await api.searchResources(providerId, query.trim(), nextCursor)
        : await api.listResources(providerId, nextCursor);
      setResources(nextCursor ? [...resources, ...page.resources] : page.resources);
      setCursor(page.nextCursor);
      if (page.resources.length === 0)
        setNotice(
          query.trim()
            ? 'No resources matched that search.'
            : 'This connection exposes no resources.',
        );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const inspect = async (resource: api.ConnectedResourceView) => {
    setSelected(resource);
    setContent(null);
    setAnalysis(null);
    try {
      const text = await api.getContent(resource.providerId, resource.resourceId);
      setContent(text);
    } catch (e) {
      setError(errorMessage(e));
    }
    try {
      const structure = await api.getAnalysis(resource.providerId, resource.resourceId);
      setAnalysis(structure);
    } catch {
      // Not every resource is a parseable document; the content view still tells the truth.
    }
  };

  return (
    <div className="v-page">
      <header className="v-page__header">
        <h1 className="v-page__title">Connected Apps</h1>
        <p className="v-page__subtitle">
          Connect an app you trust and ask Veltravia to find, read and compare what it holds. Access
          is read-only, scoped to the permissions you grant, and every result keeps its source.
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

      <section className="v-connections__providers" aria-label="Providers">
        {(overview?.providers ?? []).map((provider) => {
          const connection = connectedProviders.find(
            (candidate) => candidate.providerId === provider.id,
          );
          const providerHealth = health[provider.id];
          return (
            <article key={provider.id} className="v-connections__card">
              <div className="v-connections__card-head">
                <h2 className="v-connections__card-title">{provider.name}</h2>
                <span
                  className={`v-connections__status v-connections__status--${
                    connection ? 'connected' : 'idle'
                  }`}
                >
                  {connection ? 'Connected' : 'Not connected'}
                </span>
              </div>
              <p className="v-connections__card-text">{provider.description}</p>
              <p className="v-connections__mode">
                {provider.mode === 'live' ? 'Live API' : 'Simulated provider'}
                {provider.mode === 'mock' && ' — deterministic demo data, not a real account.'}
              </p>

              <dl className="v-connections__facts">
                {connection && (
                  <>
                    <dt>Account</dt>
                    <dd>{connection.account.displayName}</dd>
                    <dt>Granted</dt>
                    <dd>{connection.grantedScopes.join(', ')}</dd>
                    <dt>Health</dt>
                    <dd>
                      {providerHealth
                        ? providerHealth.healthy
                          ? 'Responding'
                          : 'Not responding'
                        : 'Checking…'}
                    </dd>
                  </>
                )}
                {!connection && (
                  <>
                    <dt>Permissions offered</dt>
                    <dd>{provider.scopes.map((scope) => scope.id).join(', ')}</dd>
                  </>
                )}
              </dl>

              <div className="v-connections__actions">
                {connection ? (
                  <>
                    <Button
                      variant="secondary"
                      onClick={() => void disconnect(provider.id)}
                      disabled={busy}
                    >
                      Disconnect
                    </Button>
                    <Button onClick={() => void browse(provider.id)} disabled={busy}>
                      Browse resources
                    </Button>
                  </>
                ) : (
                  <Button onClick={() => void openConnect(provider.id)} disabled={busy}>
                    Connect {provider.name}
                  </Button>
                )}
              </div>
            </article>
          );
        })}
      </section>

      <section className="v-connections__browser" aria-label="Connected resources">
        <div className="v-connections__search">
          <Input
            label="Search connected resources"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="authentication, proposal, roadmap…"
          />
          {connectedProviders.length === 0 && (
            <p className="v-connections__empty">Connect a provider to browse its resources.</p>
          )}
          {resources.length === 0 && connectedProviders.length > 0 && (
            <p className="v-connections__empty">
              Choose “Browse resources” on a connected app to list what it exposes.
            </p>
          )}
        </div>

        {resources.length > 0 && (
          <ul className="v-connections__list">
            {resources.map((resource) => (
              <li key={`${resource.providerId}:${resource.resourceId}`}>
                <button
                  type="button"
                  className={`v-connections__item${
                    selected?.resourceId === resource.resourceId ? ' is-active' : ''
                  }`}
                  onClick={() => void inspect(resource)}
                  aria-label={`Inspect ${resource.name}`}
                >
                  <span className="v-connections__item-name">{resource.name}</span>
                  <span className="v-connections__item-meta">
                    {resource.providerId} · {resource.kind}
                    {resource.revision ? ` · ${resource.revision}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {cursor && (
          <Button
            variant="secondary"
            onClick={() => void browse(resources[0]?.providerId ?? '', cursor)}
            disabled={busy}
          >
            Load more
          </Button>
        )}

        {selected && (
          <article className="v-connections__detail" aria-label="Resource detail">
            <h2 className="v-connections__detail-title">{selected.name}</h2>
            <dl className="v-connections__facts">
              <dt>Provider</dt>
              <dd>{selected.provenance.providerName}</dd>
              <dt>Account</dt>
              <dd>{selected.provenance.accountId}</dd>
              <dt>Path</dt>
              <dd>{selected.path ?? '—'}</dd>
              <dt>Revision</dt>
              <dd>{selected.revision ?? 'not reported'}</dd>
              <dt>Retrieved</dt>
              <dd>{new Date(selected.provenance.retrievedAt).toLocaleString()}</dd>
              {selected.url && (
                <>
                  <dt>Source</dt>
                  <dd>
                    <a href={selected.url} target="_blank" rel="noreferrer noopener">
                      Open original
                    </a>
                  </dd>
                </>
              )}
            </dl>

            {analysis && (
              <div className="v-connections__analysis">
                <p className="v-connections__label">
                  {analysis.format} · {analysis.elementCount} elements · {analysis.tableCount}{' '}
                  tables
                </p>
                {analysis.headings.length > 0 && (
                  <ul className="v-connections__headings">
                    {analysis.headings.map((heading) => (
                      <li key={heading}>{heading}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {content ? (
              <>
                <p className="v-connections__label">
                  Content is untrusted data · {content.mimeType} · {content.byteSize} bytes
                  {content.ageSeconds !== null && ` · ${content.ageSeconds}s old`}
                </p>
                <pre className="v-connections__content">{content.text}</pre>
              </>
            ) : (
              <p className="v-connections__empty">
                {selected.kind === 'repository'
                  ? 'Repositories have no file content. Open a file inside one.'
                  : 'Loading content…'}
              </p>
            )}
          </article>
        )}
      </section>

      <Dialog
        open={activeProvider !== null}
        title="Connect app"
        onClose={() => {
          setActiveProvider(null);
          setSession(null);
        }}
      >
        {session && (
          <div className="v-connections__dialog">
            <p>{session.authorization.reason}</p>
            <fieldset className="v-connections__scopes">
              <legend>Permissions to grant</legend>
              {session.scopes.map((scope) => (
                <label key={scope.id} className="v-connections__scope">
                  <input
                    type="checkbox"
                    checked={selectedScopes.includes(scope.id)}
                    onChange={(event) =>
                      setSelectedScopes((current) =>
                        event.target.checked
                          ? [...current, scope.id]
                          : current.filter((id) => id !== scope.id),
                      )
                    }
                  />
                  <span>
                    <strong>{scope.id}</strong> — {scope.description}
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="v-connections__actions">
              <Button
                onClick={() => void confirmConnect()}
                disabled={busy || selectedScopes.length === 0}
              >
                Authorize
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setActiveProvider(null);
                  setSession(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
