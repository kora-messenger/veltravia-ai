import { useEffect, useState, type ChangeEvent } from 'react';
import { Button, ErrorState, Input, Spinner } from '../components/ui';
import { listFiles, uploadFile, type FileView } from '../api/files';
import { errorMessage } from '../api/client';
import {
  analyzeChart,
  analyzeDiagram,
  analyzeScreenshot,
  cancelImageJob,
  compareImages,
  extractImageFields,
  getImageAnalysis,
  getImageCapabilities,
  getImageJob,
  getUiStructure,
  imageMediaUrl,
  processImage,
  queryImage,
  saveImageArtifact,
  searchAllImages,
  searchImage,
  type ChartView,
  type CompareView,
  type DiagramView,
  type ExtractView,
  type ImageAnalysisView,
  type ImageCapabilitiesView,
  type ImageJobView,
  type ImageSearchView,
  type ImageQueryView,
  type ScreenshotView,
  type UiStructureView,
} from '../api/image';

const formatBytes = (n: number) =>
  n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;
const TERMINAL = ['completed', 'failed', 'cancelled', 'expired'];

export function ImagePage() {
  const [files, setFiles] = useState<readonly FileView[]>([]);
  const [capabilities, setCapabilities] = useState<ImageCapabilitiesView | null>(null);
  const [selected, setSelected] = useState<FileView | null>(null);
  const [analysis, setAnalysis] = useState<ImageAnalysisView | null>(null);
  const [job, setJob] = useState<ImageJobView | null>(null);
  const [queryResult, setQueryResult] = useState<ImageQueryView | null>(null);
  const [searchResult, setSearchResult] = useState<ImageSearchView | null>(null);
  const [screenshot, setScreenshot] = useState<ScreenshotView | null>(null);
  const [uiStructure, setUiStructure] = useState<UiStructureView | null>(null);
  const [chart, setChart] = useState<ChartView | null>(null);
  const [diagram, setDiagram] = useState<DiagramView | null>(null);
  const [extraction, setExtraction] = useState<ExtractView | null>(null);
  const [comparison, setComparison] = useState<CompareView | null>(null);
  const [question, setQuestion] = useState('');
  const [searchText, setSearchText] = useState('');
  const [compareWith, setCompareWith] = useState('');
  const [projectId, setProjectId] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedArtifact, setSavedArtifact] = useState<{ id: string; filename: string } | null>(null);

  const load = async () => {
    setFailure(null);
    try {
      const all = await listFiles('');
      setFiles(all.filter((f) => f.category === 'image'));
    } catch (e) {
      setFailure(errorMessage(e));
    }
  };
  useEffect(() => {
    void load();
    void getImageCapabilities()
      .then(setCapabilities)
      .catch(() => undefined);
  }, []);

  // Poll the active job until it reaches a terminal state.
  useEffect(() => {
    if (!job || TERMINAL.includes(job.status)) return;
    const timer = setInterval(async () => {
      try {
        setJob(await getImageJob(job.id));
      } catch {
        /* stop polling on missing job */
      }
    }, 400);
    return () => clearInterval(timer);
  }, [job]);

  // When the job completes, fetch the analysis.
  useEffect(() => {
    if (!job || job.status !== 'completed' || !selected) return;
    void getImageAnalysis(selected.id)
      .then(setAnalysis)
      .catch((e) => setFailure(errorMessage(e)));
  }, [job?.status]);

  const onUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setFailure(null);
    try {
      await uploadFile(file, {
        projectId: projectId.trim() || null,
        workspaceId: workspaceId.trim() || null,
      });
      await load();
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setBusy(false);
      event.target.value = '';
    }
  };

  const selectFile = (file: FileView) => {
    setSelected(file);
    setJob(null);
    setAnalysis(null);
    setQueryResult(null);
    setSearchResult(null);
    setScreenshot(null);
    setUiStructure(null);
    setChart(null);
    setDiagram(null);
    setExtraction(null);
    setComparison(null);
    setSavedArtifact(null);
    setFailure(null);
    void getImageAnalysis(file.id)
      .then(setAnalysis)
      .catch(() => setAnalysis(null));
  };

  const startProcessing = async () => {
    if (!selected) return;
    setBusy(true);
    setFailure(null);
    try {
      setJob(await processImage(selected.id));
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const cancelProcessing = async () => {
    if (!job) return;
    try {
      setJob(await cancelImageJob(job.id));
    } catch (e) {
      setFailure(errorMessage(e));
    }
  };

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    setFailure(null);
    try {
      await action();
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const withSelected = (action: (fileId: string) => Promise<void>) =>
    runAction(async () => {
      if (selected) await action(selected.id);
    });

  const doQuery = () =>
    withSelected((fileId) => queryImage(fileId, question.trim()).then(setQueryResult));
  const doScreenshot = () =>
    withSelected((fileId) => analyzeScreenshot(fileId).then(setScreenshot));
  const doUiStructure = () => withSelected((fileId) => getUiStructure(fileId).then(setUiStructure));
  const doChart = () => withSelected((fileId) => analyzeChart(fileId).then(setChart));
  const doDiagram = () => withSelected((fileId) => analyzeDiagram(fileId).then(setDiagram));
  const doExtract = () =>
    withSelected((fileId) =>
      extractImageFields(fileId, ['title', 'projectCount']).then(setExtraction),
    );
  const doCompare = () =>
    runAction(async () => {
      if (selected && compareWith) setComparison(await compareImages(selected.id, compareWith));
    });
  const doSearchImage = () =>
    withSelected((fileId) => searchImage(fileId, searchText.trim()).then(setSearchResult));
  const doSearchAll = () =>
    runAction(async () => {
      if (searchText.trim()) setSearchResult(await searchAllImages(searchText.trim()));
    });
  const doSaveArtifact = (kind: string) =>
    withSelected(async (fileId) => {
      const artifact = await saveImageArtifact(fileId, kind);
      setSavedArtifact({ id: artifact.id, filename: artifact.filename });
    });

  return (
    <div className="v-page">
      <header className="v-page__header">
        <h2>Image intelligence</h2>
        <p className="v-page__subtitle">
          Understand images and screenshots over authorized files. Visible text stays untrusted data
          - it never becomes an instruction.{' '}
          {capabilities?.providerIsSimulation ? (
            <span className="v-image__sim">
              Development provider: deterministic mock simulation.
            </span>
          ) : null}
        </p>
      </header>
      {failure ? <ErrorState description={failure} /> : null}
      <div className="v-image">
        <section className="v-image__files" aria-label="Image files">
          <div className="v-image__upload">
            <label className="v-field">
              <span>Project id (optional)</span>
              <Input
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                placeholder="p_…"
                aria-label="Project id"
              />
            </label>
            <label className="v-field">
              <span>Workspace id (optional)</span>
              <Input
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                placeholder="ws_…"
                aria-label="Workspace id"
              />
            </label>
            <label className="v-button-file">
              <input
                type="file"
                accept="image/*,.png,.jpg,.jpeg,.webp,.gif,.bmp,.svg"
                onChange={onUpload}
              />
              {busy ? <Spinner aria-label="Working" /> : 'Upload image'}
            </label>
          </div>
          <ul className="v-image__list">
            {files.length === 0 ? (
              <li className="v-image__empty">No image files yet. Upload one to begin.</li>
            ) : (
              files.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    className={`v-image__file${selected?.id === f.id ? ' is-selected' : ''}`}
                    onClick={() => selectFile(f)}
                  >
                    <span className="v-image__file-name">{f.filename}</span>
                    <span className="v-image__file-meta">{formatBytes(f.size)}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </section>
        {selected ? (
          <section className="v-image__main" aria-label="Image workspace">
            <div className="v-image__preview">
              <h3>{selected.filename}</h3>
              <img
                src={imageMediaUrl(selected.id)}
                alt={`Preview of ${selected.filename}`}
                width={280}
              />
              <div className="v-image__job">
                {job && !TERMINAL.includes(job.status) ? (
                  <Button variant="secondary" onClick={() => void cancelProcessing()}>
                    Cancel processing
                  </Button>
                ) : (
                  <Button onClick={() => void startProcessing()}>
                    {busy ? <Spinner aria-label="Working" /> : 'Process image'}
                  </Button>
                )}
                {job ? (
                  <p className="v-image__job-status" data-testid="image-job-status">
                    Job {job.status} · {job.completedOperations}/{job.operations}
                    {job.error ? ` · ${job.error.code}` : ''}
                  </p>
                ) : null}
              </div>
            </div>
            {analysis?.description ? (
              <div className="v-image__panel">
                <h4>Description (AI-generated)</h4>
                <p>{analysis.description.summary}</p>
                {analysis.description.observed.length ? (
                  <>
                    <h5>Observed (provider-reported)</h5>
                    <ul>
                      {analysis.description.observed.map((o, i) => (
                        <li key={i}>{o}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {analysis.description.inferences.length ? (
                  <>
                    <h5>Inferences (AI guesses)</h5>
                    <ul>
                      {analysis.description.inferences.map((o, i) => (
                        <li key={i}>{o}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
                <p className="v-image__trust">trust: {analysis.description.trust}</p>
              </div>
            ) : null}
            {analysis?.ocr ? (
              <div className="v-image__panel">
                <h4>Extracted text (untrusted data)</h4>
                <pre className="v-image__ocr">{analysis.ocr.text}</pre>
                <p className="v-image__trust">trust: {analysis.ocr.trust}</p>
              </div>
            ) : null}
            <div className="v-image__panel">
              <h4>Ask about this image</h4>
              <div className="v-image__ask">
                <Input
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="What is shown?"
                  aria-label="Question"
                />
                <Button onClick={() => void doQuery()}>Ask</Button>
              </div>
              {queryResult ? (
                <div>
                  <p>{queryResult.answer}</p>
                  <p className="v-image__trust">
                    trust: {queryResult.trust}
                    {queryResult.insufficientEvidence ? ' · insufficient evidence' : ''}
                  </p>
                </div>
              ) : null}
            </div>
            <div className="v-image__panel">
              <h4>Search image text</h4>
              <div className="v-image__ask">
                <Input
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder="dashboard"
                  aria-label="Search term"
                />
                <Button onClick={() => void doSearchImage()}>Search this image</Button>
                <Button variant="secondary" onClick={() => void doSearchAll()}>
                  Search all images
                </Button>
              </div>
              {searchResult ? (
                <div>
                  <p>
                    {searchResult.matches.length} match
                    {searchResult.matches.length === 1 ? '' : 'es'}
                    {searchResult.truncated ? ' (truncated)' : ''} · trust: {searchResult.trust}
                  </p>
                  <ul>
                    {searchResult.matches.slice(0, 10).map((m, i) => (
                      <li key={i}>
                        {m.reason === 'stored_text' ? `file ${m.fileId}` : 'in this image'}:{' '}
                        {m.matchedText}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
            <div className="v-image__panel">
              <h4>Screenshot analysis</h4>
              <div className="v-image__actions">
                <Button variant="secondary" onClick={() => void doScreenshot()}>
                  Analyze screenshot
                </Button>
                <Button variant="secondary" onClick={() => void doUiStructure()}>
                  Extract UI structure
                </Button>
                <Button variant="secondary" onClick={() => void doChart()}>
                  Read chart
                </Button>
                <Button variant="secondary" onClick={() => void doDiagram()}>
                  Extract diagram
                </Button>
                <Button variant="secondary" onClick={() => void doExtract()}>
                  Extract fields
                </Button>
              </div>
              {screenshot ? (
                <div>
                  <h5>Issues (AI-generated)</h5>
                  <ul>
                    {screenshot.issues.map((i) => (
                      <li key={i.id}>
                        <strong>{i.kind}</strong> ({i.basis}): {i.statement}
                      </li>
                    ))}
                  </ul>
                  <p className="v-image__trust">trust: {screenshot.trust}</p>
                </div>
              ) : null}
              {uiStructure ? (
                <div>
                  <h5>UI elements</h5>
                  <ul>
                    {uiStructure.elements.map((e) => (
                      <li key={e.id}>
                        {e.kind}
                        {e.label ? `: ${e.label}` : ''}
                      </li>
                    ))}
                  </ul>
                  {uiStructure.notes.map((n) => (
                    <p key={n} className="v-image__trust">
                      {n}
                    </p>
                  ))}
                </div>
              ) : null}
              {chart ? (
                <div>
                  <h5>
                    Chart: {chart.chartType}
                    {chart.title ? ` - ${chart.title}` : ''}
                  </h5>
                  <p>Values read: {chart.values.join(', ')}</p>
                  <p className="v-image__trust">trust: {chart.trust}</p>
                </div>
              ) : null}
              {diagram ? (
                <div>
                  <h5>Diagram</h5>
                  <ul>
                    {diagram.relationships.map((r) => (
                      <li key={r.id}>
                        {nodeLabel(diagram, r.fromId)} -&gt; {nodeLabel(diagram, r.toId)} ({r.label}
                        )
                      </li>
                    ))}
                  </ul>
                  <p className="v-image__trust">trust: {diagram.trust}</p>
                </div>
              ) : null}
              {extraction ? (
                <div>
                  <h5>Extracted fields</h5>
                  <ul>
                    {extraction.fields.map((f) => (
                      <li key={f.field}>
                        {f.field}: {f.value}
                        {f.uncertain ? ' (uncertain)' : ''}
                      </li>
                    ))}
                  </ul>
                  <p className="v-image__trust">trust: {extraction.trust}</p>
                </div>
              ) : null}
            </div>
            <div className="v-image__panel">
              <h4>Compare with another image</h4>
              <div className="v-image__ask">
                <label className="v-field">
                  <span>Other image</span>
                  <select
                    aria-label="Other image"
                    value={compareWith}
                    onChange={(e) => setCompareWith(e.target.value)}
                  >
                    <option value="">Select an image…</option>
                    {files
                      .filter((f) => f.id !== selected.id)
                      .map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.filename}
                        </option>
                      ))}
                  </select>
                </label>
                <Button onClick={() => void doCompare()}>Compare</Button>
              </div>
              {comparison ? (
                <div>
                  <p>{comparison.summary}</p>
                  <ul>
                    {comparison.differences.map((d, i) => (
                      <li key={i}>
                        <strong>{d.kind}</strong> ({d.basis}): {d.statement}
                      </li>
                    ))}
                  </ul>
                  <p className="v-image__trust">trust: {comparison.trust}</p>
                </div>
              ) : null}
            </div>
            <div className="v-image__panel">
              <h4>Save artifacts</h4>
              <div className="v-image__actions">
                <Button
                  variant="secondary"
                  onClick={() => void doSaveArtifact('image_description_md')}
                >
                  Save description (markdown)
                </Button>
                <Button variant="secondary" onClick={() => void doSaveArtifact('ocr_txt')}>
                  Save extracted text (txt)
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => void doSaveArtifact('image_analysis_json')}
                >
                  Save analysis (json)
                </Button>
              </div>
              {savedArtifact ? (
                <p className="v-image__trust">Saved: {savedArtifact.filename}</p>
              ) : null}
            </div>
          </section>
        ) : (
          <section className="v-image__main v-image__main--empty">
            <p>Select an image file to inspect, process, and reason over it.</p>
          </section>
        )}
      </div>
    </div>
  );
}

function nodeLabel(diagram: DiagramView, id: string): string {
  return diagram.nodes.find((n) => n.id === id)?.label ?? 'unknown';
}
