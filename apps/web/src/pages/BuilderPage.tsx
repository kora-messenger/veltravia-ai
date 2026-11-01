import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Input, Select, Spinner, Textarea, useToast } from '../components/ui';
import { errorMessage } from '../api/client';
import { SourceExplorer } from './source/SourceExplorer';
import * as api from '../api/app-builder';

/**
 * App Builder (Step 30).
 *
 * The foundation surface, and deliberately honest about it: you can describe a
 * project in any supported stack, have the specification validated, detect a
 * stack from real file paths, and generate a starter plan you can materialize
 * into a real project. Build and test commands are shown as DECLARATIONS from
 * the registry - this release never claims it ran one.
 */

const PROJECT_KINDS: readonly api.ProjectKind[] = [
  'web',
  'mobile',
  'backend',
  'fullstack',
  'library',
  'cli',
  'data',
  'smart-contract',
  'other',
];

const AUTH_STRATEGIES = ['none', 'email-password', 'oauth', 'passkeys', 'api-key'] as const;
const DATABASES = ['none', 'postgresql', 'mysql', 'sqlite', 'mongodb', 'redis'] as const;

interface FormState {
  name: string;
  description: string;
  projectKind: api.ProjectKind;
  frontend: string;
  backend: string;
  mobile: string;
  database: string;
  authentication: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  description: '',
  projectKind: 'web',
  frontend: '',
  backend: '',
  mobile: '',
  database: 'none',
  authentication: 'none',
};

function supportTone(level: api.SupportLevel): 'success' | 'warning' | 'error' | 'neutral' {
  if (level === 'executable') return 'success';
  if (level === 'scaffold') return 'warning';
  return 'neutral';
}

function supportWords(level: api.SupportLevel): string {
  if (level === 'executable') return 'Builds and runs';
  if (level === 'scaffold') return 'Starter files';
  return 'Declared only';
}

function commandLine(command: api.CommandPlanView | null): string {
  return command === null ? 'No command declared' : command.argv.join(' ');
}

/** The specification the server validates. Roles are flat ids; absent roles are omitted. */
function toSpecification(form: FormState): Record<string, unknown> {
  const spec: Record<string, unknown> = {
    name: form.name.trim(),
    description: form.description.trim(),
    projectKind: form.projectKind,
  };
  if (form.frontend !== '') spec.frontend = form.frontend;
  if (form.backend !== '') spec.backend = form.backend;
  if (form.mobile !== '') spec.mobile = form.mobile;
  if (form.database !== 'none') spec.database = { engine: form.database, migrations: false };
  if (form.authentication !== 'none') {
    spec.authentication = { strategy: form.authentication, providers: [] };
  }
  return spec;
}

export function BuilderPage() {
  const { toast } = useToast();

  const [registry, setRegistry] = useState<readonly api.TechnologyView[]>([]);
  const [registryError, setRegistryError] = useState('');
  const [loadingRegistry, setLoadingRegistry] = useState(true);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [review, setReview] = useState<api.SpecificationReviewView | null>(null);
  const [reviewError, setReviewError] = useState('');
  const [validating, setValidating] = useState(false);

  const [manifest, setManifest] = useState('');
  const [detection, setDetection] = useState<api.TechnologyStackDetectionView | null>(null);
  const [detectionError, setDetectionError] = useState('');
  const [detecting, setDetecting] = useState(false);

  const [plan, setPlan] = useState<api.ScaffoldPlanView | null>(null);
  const [planError, setPlanError] = useState('');
  const [planning, setPlanning] = useState(false);
  const [materialized, setMaterialized] = useState<api.MaterializeResultView | null>(null);
  const [materializing, setMaterializing] = useState(false);

  const loadRegistry = useCallback(async () => {
    setRegistryError('');
    setLoadingRegistry(true);
    try {
      setRegistry(await api.fetchRegistry());
    } catch (error) {
      setRegistryError(errorMessage(error));
    } finally {
      setLoadingRegistry(false);
    }
  }, []);

  useEffect(() => {
    void loadRegistry();
  }, [loadRegistry]);

  const byLayer = useMemo(() => {
    const group = (layer: string, kinds: readonly api.ProjectKind[]) =>
      registry.filter((entry) => entry.kind === 'framework' && entry.layer === layer).length > 0
        ? registry
            .filter((entry) => entry.layer === layer)
            .filter((entry) => entry.kind === 'framework' || kinds.includes(form.projectKind))
            .map((entry) => ({
              value: entry.id,
              label: `${entry.name} (${supportWords(entry.supportLevel)})`,
            }))
        : [];
    return {
      frontend: group('frontend', ['web', 'fullstack', 'mobile']),
      backend: group('backend', ['backend', 'fullstack', 'data']),
      mobile: group('mobile', ['mobile']),
    };
  }, [registry, form.projectKind]);

  const counts = useMemo(() => {
    const tally: Record<api.SupportLevel, number> = { executable: 0, scaffold: 0, planned: 0 };
    for (const entry of registry) tally[entry.supportLevel] += 1;
    return tally;
  }, [registry]);

  const update = (patch: Partial<FormState>) => setForm((previous) => ({ ...previous, ...patch }));

  const onValidate = useCallback(async () => {
    setReviewError('');
    setReview(null);
    setValidating(true);
    try {
      setReview(await api.validateSpecification(toSpecification(form)));
    } catch (error) {
      setReviewError(errorMessage(error));
    } finally {
      setValidating(false);
    }
  }, [form]);

  const onDetect = useCallback(async () => {
    setDetectionError('');
    setDetection(null);
    const paths = manifest
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (paths.length === 0) {
      setDetectionError('Paste at least one file path, one per line.');
      return;
    }
    setDetecting(true);
    try {
      setDetection(await api.detectStack(paths.map((path) => ({ path }))));
    } catch (error) {
      setDetectionError(errorMessage(error));
    } finally {
      setDetecting(false);
    }
  }, [manifest]);

  const onCreatePlan = useCallback(async () => {
    setPlanError('');
    setPlan(null);
    setMaterialized(null);
    setPlanning(true);
    try {
      setPlan(await api.createPlan(toSpecification(form)));
    } catch (error) {
      setPlanError(errorMessage(error));
    } finally {
      setPlanning(false);
    }
  }, [form]);

  const onMaterialize = useCallback(async () => {
    if (plan === null) return;
    setMaterializing(true);
    setPlanError('');
    try {
      const result = await api.materializePlan(plan.id);
      setMaterialized(result);
      setPlan({ ...plan, status: 'materialized' });
      toast(`Created project with ${result.createdFiles.length} files.`, { tone: 'success' });
    } catch (error) {
      setPlanError(errorMessage(error));
    } finally {
      setMaterializing(false);
    }
  }, [plan, toast]);

  return (
    <div className="v-page v-builder">
      <header className="v-page-header">
        <div>
          <h1 className="v-page-header__title">App Builder</h1>
          <p className="v-page-header__description">
            Describe a project in the stack you want. The platform validates the specification,
            detects an existing stack from file paths, and plans starter files. It never swaps your
            chosen language for a convenient one.
          </p>
        </div>
        <div className="v-builder__chips">
          <Badge tone={counts.executable > 0 ? 'success' : 'neutral'}>
            {counts.executable} buildable
          </Badge>
          <Badge tone="warning">{counts.scaffold} with starter files</Badge>
          <Badge tone="neutral">{counts.planned} declared only</Badge>
        </div>
      </header>

      {registryError !== '' && (
        <Card>
          <p className="v-builder__error" role="alert">
            {registryError}
          </p>
          <Button variant="secondary" onClick={() => void loadRegistry()}>
            Try again
          </Button>
        </Card>
      )}

      {loadingRegistry && registry.length === 0 && registryError === '' && (
        <Card>
          <p className="v-builder__hint">
            <Spinner /> Loading the technology registry…
          </p>
        </Card>
      )}

      <div className="v-builder__grid">
        <Card>
          <h2 className="v-builder__heading">Project</h2>
          <div className="v-builder__form">
            <label className="v-builder__field">
              <span className="v-builder__label">Name</span>
              <Input
                name="name"
                value={form.name}
                onChange={(event) => update({ name: event.target.value })}
                placeholder="Ledger service"
              />
            </label>
            <label className="v-builder__field">
              <span className="v-builder__label">What it does</span>
              <Textarea
                name="description"
                value={form.description}
                onChange={(event) => update({ description: event.target.value })}
                rows={3}
                placeholder="Records invoices and exports monthly totals."
              />
            </label>
            <label className="v-builder__field">
              <span className="v-builder__label">Application type</span>
              <Select
                name="projectKind"
                value={form.projectKind}
                options={PROJECT_KINDS.map((kind) => ({ value: kind, label: kind }))}
                onChange={(event) => update({ projectKind: event.target.value as api.ProjectKind })}
              />
            </label>
            <label className="v-builder__field">
              <span className="v-builder__label">Frontend</span>
              <Select
                name="frontend"
                value={form.frontend}
                options={[{ value: '', label: 'None' }, ...byLayer.frontend]}
                onChange={(event) => update({ frontend: event.target.value })}
              />
            </label>
            <label className="v-builder__field">
              <span className="v-builder__label">Backend</span>
              <Select
                name="backend"
                value={form.backend}
                options={[{ value: '', label: 'None' }, ...byLayer.backend]}
                onChange={(event) => update({ backend: event.target.value })}
              />
            </label>
            <label className="v-builder__field">
              <span className="v-builder__label">Mobile</span>
              <Select
                name="mobile"
                value={form.mobile}
                options={[{ value: '', label: 'None' }, ...byLayer.mobile]}
                onChange={(event) => update({ mobile: event.target.value })}
              />
            </label>
            <label className="v-builder__field">
              <span className="v-builder__label">Database</span>
              <Select
                name="database"
                value={form.database}
                options={DATABASES.map((engine) => ({ value: engine, label: engine }))}
                onChange={(event) => update({ database: event.target.value })}
              />
            </label>
            <label className="v-builder__field">
              <span className="v-builder__label">Sign-in</span>
              <Select
                name="authentication"
                value={form.authentication}
                options={AUTH_STRATEGIES.map((strategy) => ({ value: strategy, label: strategy }))}
                onChange={(event) => update({ authentication: event.target.value })}
              />
            </label>
            <div className="v-builder__actions">
              <Button onClick={() => void onValidate()} disabled={validating}>
                {validating ? 'Validating…' : 'Validate specification'}
              </Button>
              <Button variant="secondary" onClick={() => void onCreatePlan()} disabled={planning}>
                {planning ? 'Planning…' : 'Create starter plan'}
              </Button>
            </div>
          </div>

          {reviewError !== '' && (
            <p className="v-builder__error" role="alert">
              {reviewError}
            </p>
          )}

          {review !== null && (
            <div className="v-builder__review" aria-live="polite" data-testid="review">
              <div className="v-builder__row">
                <Badge tone={review.valid ? 'success' : 'error'}>
                  {review.valid ? 'Valid specification' : 'Needs fixing'}
                </Badge>
                <Badge tone={supportTone(review.supportLevel)}>
                  {supportWords(review.supportLevel)}
                </Badge>
              </div>
              {review.resolved.length > 0 && (
                <p className="v-builder__hint">
                  Resolved stack:{' '}
                  {review.resolved.map((item) => `${item.name} (${item.role})`).join(', ')}
                </p>
              )}
              {review.issues.length > 0 && (
                <ul className="v-builder__list">
                  {review.issues.map((issue) => (
                    <li key={`${issue.path}-${issue.code}`}>
                      <strong>{issue.severity === 'error' ? 'Error' : 'Warning'}</strong>{' '}
                      {issue.path}: {issue.message}
                    </li>
                  ))}
                </ul>
              )}
              {review.unsupported.length > 0 && (
                <ul className="v-builder__list">
                  {review.unsupported.map((item) => (
                    <li key={item.id}>
                      {item.id}: {item.reason}
                    </li>
                  ))}
                </ul>
              )}
              {review.notes.map((note) => (
                <p className="v-builder__hint" key={note}>
                  {note}
                </p>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <h2 className="v-builder__heading">Detect an existing stack</h2>
          <p className="v-builder__hint">
            Paste file paths, one per line. Detection reads names only, so it cannot run anything or
            reveal file contents.
          </p>
          <Textarea
            value={manifest}
            onChange={(event) => setManifest(event.target.value)}
            rows={6}
            placeholder={'package.json\nsrc/App.tsx\nvite.config.ts'}
            aria-label="File paths to inspect"
          />
          <div className="v-builder__actions">
            <Button variant="secondary" onClick={() => void onDetect()} disabled={detecting}>
              {detecting ? 'Detecting…' : 'Detect stack'}
            </Button>
          </div>
          {detectionError !== '' && (
            <p className="v-builder__error" role="alert">
              {detectionError}
            </p>
          )}
          {detection !== null && (
            <div className="v-builder__review" aria-live="polite" data-testid="review">
              {detection.projects.length === 0 &&
                detection.languages.length === 0 &&
                detection.frameworks.length === 0 && (
                  <p className="v-builder__hint">Nothing recognisable in those paths.</p>
                )}
              {detection.frameworks.length > 0 && (
                <p className="v-builder__hint">
                  Frameworks: {detection.frameworks.map((item) => item.name).join(', ')}
                </p>
              )}
              {detection.languages.length > 0 && (
                <p className="v-builder__hint">
                  Languages: {detection.languages.map((item) => item.name).join(', ')}
                </p>
              )}
              {detection.unknownLanguages.length > 0 && (
                <p className="v-builder__hint">
                  Not in the registry yet: {detection.unknownLanguages.join(', ')}
                </p>
              )}
              {detection.notes.map((note) => (
                <p className="v-builder__hint" key={note}>
                  {note}
                </p>
              ))}
            </div>
          )}
        </Card>
      </div>

      {planError !== '' && (
        <Card>
          <p className="v-builder__error" role="alert">
            {planError}
          </p>
        </Card>
      )}

      {plan !== null && (
        <Card>
          <div className="v-builder__row">
            <h2 className="v-builder__heading">{plan.specification.name}</h2>
            <Badge tone={plan.status === 'materialized' ? 'success' : 'neutral'}>
              {plan.status === 'materialized' ? 'Created' : 'Planned'}
            </Badge>
          </div>
          <p className="v-builder__hint">
            Build: {commandLine(plan.buildCommand)} · Test: {commandLine(plan.testCommand)}
          </p>
          <p className="v-builder__hint">
            Preview: {plan.preview.mode} — {plan.preview.note}
          </p>
          <p className="v-builder__hint" role="note">
            These commands come from the registry. This release does not run them, so nothing here
            has been built or tested.
          </p>
          <details className="v-builder__files" data-testid="plan">
            <summary>{plan.files.length} planned files</summary>
            <ul className="v-builder__list">
              {plan.files.map((file) => (
                <li key={file.path}>
                  <code>{file.path}</code> — {file.description}
                </li>
              ))}
            </ul>
          </details>
          {materialized === null ? (
            <div className="v-builder__actions">
              <Button onClick={() => void onMaterialize()} disabled={materializing}>
                {materializing ? 'Creating…' : 'Create project from plan'}
              </Button>
            </div>
          ) : (
            <>
              <p className="v-builder__hint" data-testid="materialized">
                Created project <code>{materialized.projectId}</code> with{' '}
                {materialized.createdFiles.length} files in workspace{' '}
                <code>{materialized.workspaceId}</code>.
              </p>
              <SourceExplorer projectId={materialized.projectId} />
            </>
          )}
        </Card>
      )}

      <Card>
        <h2 className="v-builder__heading">Technology registry</h2>
        {registry.length === 0 ? (
          <p className="v-builder__hint">
            {loadingRegistry ? 'Loading…' : 'No technologies are registered.'}
          </p>
        ) : (
          <ul className="v-builder__registry">
            {registry.map((entry) => (
              <li key={entry.id} className="v-builder__registry-item">
                <span className="v-builder__registry-name">{entry.name}</span>
                <Badge tone={supportTone(entry.supportLevel)}>
                  {supportWords(entry.supportLevel)}
                </Badge>
                <span className="v-builder__hint">{entry.layer}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
