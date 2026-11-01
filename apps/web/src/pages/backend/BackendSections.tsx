import { useMemo, useState } from 'react';
import { Badge, Button, EmptyState, Input } from '../../components/ui';
import type {
  BackendCapabilities,
  BackendModel,
  BackendReport,
  BackendRoute,
  BackendSection,
} from '../../api/backend';

/**
 * Backend Builder sections (Step 33).
 *
 * Every panel renders only what the report contains. Where the report says a
 * capability does not exist (a live database connection, log entries), the panel
 * says so in plain words instead of drawing a mock of it. Provenance (file and
 * line) is always one click from the claim, because a backend description is
 * only useful if you can check it.
 */

export const BACKEND_SECTIONS: readonly { readonly id: BackendSection; readonly label: string }[] =
  [
    { id: 'overview', label: 'Overview' },
    { id: 'routes', label: 'Routes' },
    { id: 'database', label: 'Database' },
    { id: 'models', label: 'Models' },
    { id: 'functions', label: 'Functions' },
    { id: 'auth', label: 'Authentication' },
    { id: 'environment', label: 'Environment' },
    { id: 'logs', label: 'Logs' },
  ];

const SECTION_STATE_WORDS: Record<string, string> = {
  implemented: 'read from files',
  'inspection-only': 'inspection only',
  'names-only': 'names only',
  unavailable: 'not available',
};

const SECTION_STATE_TONE: Record<string, 'success' | 'neutral' | 'warning' | 'error'> = {
  implemented: 'success',
  'inspection-only': 'neutral',
  'names-only': 'neutral',
  unavailable: 'warning',
};

function countFor(report: BackendReport, section: BackendSection): number | null {
  switch (section) {
    case 'routes':
      return report.routes.length;
    case 'models':
      return report.models.length;
    case 'functions':
      return report.functions.length;
    case 'environment':
      return report.environment.length;
    default:
      return null;
  }
}

export interface BackendNavProps {
  readonly report: BackendReport | null;
  readonly capabilities: BackendCapabilities | null;
  readonly active: BackendSection;
  readonly onSelect: (section: BackendSection) => void;
}

export function BackendNav({ report, capabilities, active, onSelect }: BackendNavProps) {
  return (
    <nav className="v-bbuilder__nav" aria-label="Backend sections">
      <ul className="v-bbuilder__nav-list">
        {BACKEND_SECTIONS.map((section) => {
          const state = capabilities?.sections[section.id];
          const count = report === null ? null : countFor(report, section.id);
          return (
            <li key={section.id}>
              <button
                type="button"
                className={`v-bbuilder__nav-item${active === section.id ? ' v-bbuilder__nav-item--active' : ''}`}
                aria-current={active === section.id ? 'page' : undefined}
                onClick={() => onSelect(section.id)}
              >
                <span className="v-bbuilder__nav-label">{section.label}</span>
                {count !== null && <span className="v-bbuilder__nav-count">{count}</span>}
                {state !== undefined && state !== 'implemented' && (
                  <span
                    className="v-bbuilder__nav-state"
                    title={SECTION_STATE_WORDS[state] ?? state}
                  >
                    {state === 'unavailable' ? '—' : '·'}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {capabilities !== null && (
        <p className="v-bbuilder__nav-note">
          This workspace is read-only. File changes go through the AI panel and a coding run you
          approve.
        </p>
      )}
    </nav>
  );
}

function Panel({
  title,
  description,
  actions,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly actions?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="v-bbuilder__panel" aria-label={title}>
      <header className="v-bbuilder__panel-head">
        <div>
          <h2 className="v-bbuilder__panel-title">{title}</h2>
          {description !== undefined && <p className="v-bbuilder__panel-lede">{description}</p>}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

function Stat({
  label,
  value,
  note,
}: {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
}) {
  return (
    <div className="v-bbuilder__stat">
      <p className="v-bbuilder__stat-label">{label}</p>
      <p className="v-bbuilder__stat-value">{value}</p>
      {note !== undefined && <p className="v-bbuilder__stat-note">{note}</p>}
    </div>
  );
}

function Evidence({ children }: { readonly children: React.ReactNode }) {
  return <pre className="v-bbuilder__evidence">{children}</pre>;
}

export interface SectionProps {
  readonly report: BackendReport;
  readonly capabilities: BackendCapabilities | null;
}

export function BackendOverview({ report, capabilities }: SectionProps) {
  const stack = report.structure;
  return (
    <div className="v-bbuilder__stack">
      <section className="v-bbuilder__stats" aria-label="Backend summary">
        <Stat
          label="Routes"
          value={String(report.routes.length)}
          note={`${report.routes.filter((route) => route.auth === 'declared').length} guarded in-file`}
        />
        <Stat
          label="Models"
          value={String(report.models.length)}
          note={report.database.provider ?? 'no ORM declared'}
        />
        <Stat
          label="Functions"
          value={String(report.functions.length)}
          note="serverless handlers"
        />
        <Stat label="Env vars" value={String(report.environment.length)} note="names only" />
      </section>

      <Panel
        title="Detected backend"
        description="Read from manifests and file layout, not assumed."
      >
        <dl className="v-bbuilder__facts">
          <div>
            <dt>Framework</dt>
            <dd>{stack.framework ?? 'not recognised'}</dd>
          </div>
          <div>
            <dt>Language</dt>
            <dd>{stack.language ?? 'not recognised'}</dd>
          </div>
          <div>
            <dt>Runtime</dt>
            <dd>{stack.runtime ?? 'not declared'}</dd>
          </div>
          <div>
            <dt>Layout</dt>
            <dd>{stack.layout}</dd>
          </div>
          <div>
            <dt>Files scanned</dt>
            <dd>
              {report.scanned.read} of {report.scanned.files}
              {report.scanned.truncated ? ' (truncated)' : ''}
            </dd>
          </div>
        </dl>
        {stack.sections.length > 0 && (
          <ul className="v-bbuilder__chips" aria-label="Backend file groups">
            {stack.sections.map((section) => (
              <li key={section.section}>
                <Badge tone="neutral">
                  {section.label} {section.count}
                  {section.omitted > 0 ? ` (+${section.omitted})` : ''}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {report.recentChanges.length > 0 && (
        <Panel title="Recent backend changes" description="From native source history.">
          <ul className="v-bbuilder__list">
            {report.recentChanges.map((change) => (
              <li key={`${change.path}-${change.at}`} className="v-bbuilder__list-row">
                <code className="v-bbuilder__path">{change.path}</code>
                <Badge tone="neutral">{change.changeKind}</Badge>
                <time className="v-bbuilder__time" dateTime={change.at}>
                  {change.at.replace('T', ' ').slice(0, 16)}
                </time>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {capabilities !== null && (
        <Panel
          title="What this release does not do"
          description="Stated here so nothing below reads as more than it is."
        >
          <ul className="v-bbuilder__bullets">
            {capabilities.unavailable.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

export function BackendRoutes({ report }: SectionProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<BackendRoute | null>(null);
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (term === '') return report.routes;
    return report.routes.filter((route) => {
      const haystack =
        `${route.method} ${route.path} ${route.handler ?? ''} ${route.file}`.toLowerCase();
      return haystack.includes(term);
    });
  }, [query, report.routes]);

  return (
    <Panel
      title="API routes"
      description={`${report.routes.length} declarations found across the project files.`}
      actions={
        <Input
          label="Filter routes"
          name="route-filter"
          placeholder="path, method or file"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      }
    >
      {report.routes.length === 0 ? (
        <EmptyState
          title="No routes found"
          description="No supported route declaration appeared in the files that were read. That is an honest empty result, not a hidden failure."
        />
      ) : filtered.length === 0 ? (
        <EmptyState title="No matching routes" description={`Nothing matched "${query}".`} />
      ) : (
        <div className="v-bbuilder__table-wrap">
          <table className="v-bbuilder__table">
            <caption className="v-bbuilder__caption">
              Route, method, the file that declares it and whether a guard appears in that file.
            </caption>
            <thead>
              <tr>
                <th scope="col">Method</th>
                <th scope="col">Path</th>
                <th scope="col">Handler</th>
                <th scope="col">Auth</th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((route) => (
                <tr
                  key={`${route.file}:${route.line}:${route.method}:${route.path}`}
                  className={selected === route ? 'is-selected' : undefined}
                >
                  <td>
                    <Badge tone="primary">{route.method}</Badge>
                  </td>
                  <td>
                    <code>{route.path}</code>
                  </td>
                  <td>{route.handler ?? 'inline handler'}</td>
                  <td>
                    <Badge tone={route.auth === 'declared' ? 'success' : 'neutral'}>
                      {route.auth === 'declared' ? 'guarded' : 'unknown'}
                    </Badge>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="v-bbuilder__link-button"
                      onClick={() => setSelected(route)}
                    >
                      {route.file}:{route.line}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected !== null && (
        <div className="v-bbuilder__detail" data-testid="route-detail">
          <header className="v-bbuilder__detail-head">
            <Badge tone="primary">{selected.method}</Badge>
            <code className="v-bbuilder__detail-path">{selected.path}</code>
            <Button variant="secondary" onClick={() => setSelected(null)}>
              Close
            </Button>
          </header>
          <dl className="v-bbuilder__facts">
            <div>
              <dt>Declared in</dt>
              <dd>
                {selected.file}:{selected.line}
              </dd>
            </div>
            <div>
              <dt>Handler</dt>
              <dd>{selected.handler ?? 'inline'}</dd>
            </div>
            <div>
              <dt>Parsed by</dt>
              <dd>{selected.source}</dd>
            </div>
            <div>
              <dt>Auth</dt>
              <dd>
                {selected.auth === 'declared'
                  ? 'A guard or middleware appears on this declaration.'
                  : 'No guard appears in this file. That is not proof the route is open.'}
              </dd>
            </div>
          </dl>
          <p className="v-bbuilder__detail-label">As written:</p>
          <Evidence>{selected.evidence}</Evidence>
        </div>
      )}
    </Panel>
  );
}

export function BackendDatabase({ report }: SectionProps) {
  const { database, models } = report;
  return (
    <div className="v-bbuilder__stack">
      <Panel title="Database" description="Declared configuration, not a live connection.">
        <dl className="v-bbuilder__facts">
          <div>
            <dt>Status</dt>
            <dd>{database.status === 'declared' ? 'declared in project files' : 'not declared'}</dd>
          </div>
          <div>
            <dt>Provider</dt>
            <dd>{database.provider ?? 'not recognised'}</dd>
          </div>
          <div>
            <dt>Connection</dt>
            <dd>not configured — this release opens no database connection</dd>
          </div>
          <div>
            <dt>Models</dt>
            <dd>{database.models} declared</dd>
          </div>
        </dl>
        <p className="v-bbuilder__note" role="note">
          {database.note}
        </p>
        {database.evidence.length > 0 && (
          <>
            <p className="v-bbuilder__detail-label">Evidence:</p>
            <ul className="v-bbuilder__bullets">
              {database.evidence.map((line) => (
                <li key={line}>
                  <code>{line}</code>
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>

      <Panel
        title="Schema at a glance"
        description="Every model found in the project's schema files."
      >
        {models.length === 0 ? (
          <EmptyState
            title="No schema found"
            description="No Prisma model or SQL table definition appeared in the files that were read."
          />
        ) : (
          <ul className="v-bbuilder__chips" aria-label="Models">
            {models.map((model) => (
              <li key={`${model.source}:${model.name}`}>
                <Badge tone="info">
                  {model.name} · {model.fields.length} fields
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function ModelCard({ model }: { readonly model: BackendModel }) {
  return (
    <article className="v-bbuilder__model">
      <header className="v-bbuilder__model-head">
        <h3 className="v-bbuilder__model-name">{model.name}</h3>
        <Badge tone="neutral">{model.source}</Badge>
        <span className="v-bbuilder__model-source">
          {model.file}:{model.line}
        </span>
      </header>
      <div className="v-bbuilder__table-wrap">
        <table className="v-bbuilder__table">
          <caption className="v-bbuilder__caption">Fields of {model.name}</caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Type</th>
              <th scope="col">Rules</th>
            </tr>
          </thead>
          <tbody>
            {model.fields.map((field) => (
              <tr key={field.name}>
                <td>
                  <code>{field.name}</code>
                </td>
                <td>{field.type}</td>
                <td>
                  <span className="v-bbuilder__badges">
                    {field.primaryKey && <Badge tone="primary">primary key</Badge>}
                    {field.unique && <Badge tone="info">unique</Badge>}
                    {field.required ? (
                      <Badge tone="neutral">required</Badge>
                    ) : (
                      <Badge tone="neutral">optional</Badge>
                    )}
                    {field.references !== null && (
                      <Badge tone="warning">→ {field.references}</Badge>
                    )}
                  </span>
                </td>
              </tr>
            ))}
            {model.fields.length === 0 && (
              <tr>
                <td colSpan={3}>No fields could be read from this definition.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {model.relationships.length > 0 && (
        <p className="v-bbuilder__model-rel">
          <span className="v-bbuilder__detail-label">Relations:</span>{' '}
          {model.relationships
            .map((relation) => `${relation.field} → ${relation.target} (${relation.cardinality})`)
            .join(', ')}
        </p>
      )}
      {model.indexes.length > 0 && (
        <p className="v-bbuilder__model-rel">
          <span className="v-bbuilder__detail-label">Indexes:</span> {model.indexes.join(', ')}
        </p>
      )}
    </article>
  );
}

export function BackendModels({ report }: SectionProps) {
  return (
    <Panel
      title="Data models"
      description="Field-level detail exactly as declared, with the file it came from."
    >
      {report.models.length === 0 ? (
        <EmptyState
          title="No models found"
          description="Nothing in the project declares a Prisma model or a SQL table."
        />
      ) : (
        <div className="v-bbuilder__models">
          {report.models.map((model) => (
            <ModelCard key={`${model.source}:${model.file}:${model.name}`} model={model} />
          ))}
        </div>
      )}
    </Panel>
  );
}

export function BackendFunctions({ report }: SectionProps) {
  return (
    <Panel
      title="Functions"
      description="Serverless handlers and request entry points found in the files."
    >
      {report.functions.length === 0 ? (
        <EmptyState
          title="No functions found"
          description="No serverless handler or request entry point was recognised. Functions are inspected here, never executed."
        />
      ) : (
        <div className="v-bbuilder__table-wrap">
          <table className="v-bbuilder__table">
            <caption className="v-bbuilder__caption">
              Functions are described from their files. This release cannot run or invoke them.
            </caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Kind</th>
                <th scope="col">File</th>
                <th scope="col">Runtime</th>
                <th scope="col">Schemas</th>
              </tr>
            </thead>
            <tbody>
              {report.functions.map((fn) => (
                <tr key={`${fn.file}:${fn.name}`}>
                  <td>
                    <code>{fn.name}</code>
                  </td>
                  <td>{fn.kind === 'serverless-function' ? 'serverless' : 'request handler'}</td>
                  <td>{fn.file}</td>
                  <td>{fn.runtime ?? 'not declared'}</td>
                  <td>
                    input {fn.inputSchema === 'declared' ? 'declared' : 'not declared'}, output{' '}
                    {fn.outputSchema === 'declared' ? 'declared' : 'not declared'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export function BackendAuth({ report }: SectionProps) {
  const { auth } = report;
  return (
    <Panel
      title="Authentication"
      description="What the project declares. Session behaviour is not inspected in this release."
    >
      <dl className="v-bbuilder__facts">
        <div>
          <dt>Status</dt>
          <dd>{auth.status === 'declared' ? 'declared' : 'no auth library declared'}</dd>
        </div>
        <div>
          <dt>Provider</dt>
          <dd>{auth.provider ?? 'none recognised'}</dd>
        </div>
        <div>
          <dt>Guarded routes</dt>
          <dd>
            {auth.protectedRoutes} of {report.routes.length} found routes show a guard in their own
            file
          </dd>
        </div>
        <div>
          <dt>User model</dt>
          <dd>{auth.userModel ?? 'not identified'}</dd>
        </div>
        <div>
          <dt>Session strategy</dt>
          <dd>not inspected</dd>
        </div>
      </dl>
      {auth.loginMethods.length > 0 && (
        <>
          <p className="v-bbuilder__detail-label">Declared sign-in methods:</p>
          <ul className="v-bbuilder__chips">
            {auth.loginMethods.map((method) => (
              <li key={method}>
                <Badge tone="info">{method}</Badge>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="v-bbuilder__note" role="note">
        {auth.note}
      </p>
      {auth.evidence.length > 0 && (
        <>
          <p className="v-bbuilder__detail-label">Evidence:</p>
          <Evidence>{auth.evidence.join('\n')}</Evidence>
        </>
      )}
    </Panel>
  );
}

export function BackendEnvironment({ report }: SectionProps) {
  return (
    <Panel
      title="Environment variables"
      description="Names and where they are referenced. Values are never read, stored or shown."
    >
      <p className="v-bbuilder__note" role="note">
        A name here tells you what the project expects to be configured. It does not tell you
        whether that variable is set anywhere.
      </p>
      {report.environment.length === 0 ? (
        <EmptyState
          title="No environment variables found"
          description="Nothing in the files read references an environment variable."
        />
      ) : (
        <div className="v-bbuilder__table-wrap">
          <table className="v-bbuilder__table">
            <caption className="v-bbuilder__caption">Variable names and their source files</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Kind</th>
                <th scope="col">Referenced in</th>
              </tr>
            </thead>
            <tbody>
              {report.environment.map((variable) => (
                <tr key={variable.name}>
                  <td>
                    <code>{variable.name}</code>
                  </td>
                  <td>{variable.kind === 'code' ? 'read at runtime' : 'example template'}</td>
                  <td>{variable.sources.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export function BackendLogs({ report }: SectionProps) {
  return (
    <Panel title="Logs" description="Runtime output for this project's backend.">
      <EmptyState
        title={report.logs.available ? 'Logs' : 'No log source connected'}
        description={report.logs.reason}
      />
      <p className="v-bbuilder__note" role="note">
        When logs become available, they will be shown as untrusted data with obvious secret
        patterns masked. Nothing is streamed today.
      </p>
    </Panel>
  );
}

export function BackendSectionView({
  section,
  report,
  capabilities,
}: {
  readonly section: BackendSection;
  readonly report: BackendReport;
  readonly capabilities: BackendCapabilities | null;
}) {
  switch (section) {
    case 'overview':
      return <BackendOverview report={report} capabilities={capabilities} />;
    case 'routes':
      return <BackendRoutes report={report} capabilities={capabilities} />;
    case 'database':
      return <BackendDatabase report={report} capabilities={capabilities} />;
    case 'models':
      return <BackendModels report={report} capabilities={capabilities} />;
    case 'functions':
      return <BackendFunctions report={report} capabilities={capabilities} />;
    case 'auth':
      return <BackendAuth report={report} capabilities={capabilities} />;
    case 'environment':
      return <BackendEnvironment report={report} capabilities={capabilities} />;
    case 'logs':
      return <BackendLogs report={report} capabilities={capabilities} />;
    default:
      return null;
  }
}

export { SECTION_STATE_TONE, SECTION_STATE_WORDS };
