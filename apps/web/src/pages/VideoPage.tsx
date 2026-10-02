import { useEffect, useRef, useState } from 'react';
import { Button, Input } from '../components/ui';
import { listFiles, uploadFile, type FileView } from '../api/files';
import { errorMessage } from '../api/client';
import * as api from '../api/video';
const terminal = ['completed', 'failed', 'cancelled', 'expired'];
const time = (v: number | null) => (v === null ? 'Unknown time' : `${v.toFixed(1)}s`);
export function VideoPage() {
  const [files, setFiles] = useState<readonly FileView[]>([]),
    [id, setId] = useState(''),
    [meta, setMeta] = useState<api.VideoMetadata | null>(null),
    [analysis, setAnalysis] = useState<api.VideoAnalysis | null>(null),
    [job, setJob] = useState<api.VideoJob | null>(null),
    [timeline, setTimeline] = useState<api.VideoTimeline | null>(null),
    [query, setQuery] = useState<api.VideoQuery | null>(null),
    [summary, setSummary] = useState<api.VideoSummary | null>(null),
    [simulation, setSimulation] = useState<boolean | null>(null),
    [question, setQuestion] = useState(''),
    [mode, setMode] = useState('general'),
    [kind, setKind] = useState('transcript_txt'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const generation = useRef(0);
  const active = job !== null && !terminal.includes(job.status),
    locked = busy || active;
  useEffect(() => {
    let live = true;
    Promise.all([listFiles(), api.getVideoCapabilities()])
      .then(([f, c]) => {
        if (live) {
          setFiles(f.filter((v) => v.category === 'video'));
          setSimulation(c.providerIsSimulation);
        }
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      });
    return () => {
      live = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    const g = ++generation.current;
    setMeta(null);
    setAnalysis(null);
    setJob(null);
    setTimeline(null);
    setQuery(null);
    setSummary(null);
    setNotice('');
    setError('');
    if (id) {
      api
        .inspectVideo(id)
        .then((v) => {
          if (g === generation.current) setMeta(v);
        })
        .catch((e) => {
          if (g === generation.current) setError(errorMessage(e));
        });
      api
        .getVideoAnalysis(id)
        .then((v) => {
          if (g === generation.current) setAnalysis(v);
        })
        .catch(() => undefined);
    }
    return () => {
      generation.current++;
    };
  }, [id]);
  useEffect(() => {
    if (!job || terminal.includes(job.status)) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const g = generation.current;
    const poll = async () => {
      try {
        const j = await api.getVideoJob(job.id);
        if (!live || g !== generation.current) return;
        setJob(j);
        if (j.status === 'completed') {
          const a = await api.getVideoAnalysis(id);
          if (g === generation.current) setAnalysis(a);
        } else if (j.error) setError(j.error.message);
        if (!terminal.includes(j.status)) timer = setTimeout(poll, 500);
      } catch (e) {
        if (live) setError(errorMessage(e));
      }
    };
    timer = setTimeout(poll, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [job?.id, job?.status, id]);
  async function run(f: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await f();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="v-page">
      <header className="v-page__header">
        <div>
          <h1 className="v-page__title">Video intelligence</h1>
          <p className="v-page__subtitle">
            Explore spoken words, visible text and events over time.
          </p>
        </div>
      </header>
      {simulation !== null && (
        <p className="v-video__notice">
          {simulation
            ? 'Deterministic simulation. These sample outputs are scripted, not real video-model analysis.'
            : 'Provider-generated interpretation. Verify important claims against the source.'}
        </p>
      )}
      <div className="v-video__layout">
        <aside className="v-video__panel">
          <Input
            label="Upload video"
            type="file"
            accept="video/*,.mkv,.m4v"
            disabled={locked}
            hint="Development uploads are limited to 25 MB."
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f)
                void run(async () => {
                  const v = await uploadFile(f, { projectId: null, workspaceId: null });
                  if (v.category !== 'video')
                    throw new Error('This file was not identified as video.');
                  setFiles((await listFiles()).filter((v) => v.category === 'video'));
                  setId(v.id);
                });
              e.target.value = '';
            }}
          />
          <h2>Your videos</h2>
          {files.length === 0 ? (
            <p>No videos yet. Upload one to begin.</p>
          ) : (
            files.map((f) => (
              <button
                key={f.id}
                className="v-video__file"
                aria-pressed={f.id === id}
                disabled={locked}
                onClick={() => setId(f.id)}
              >
                {f.filename}
                <small>{(f.size / 1024 / 1024).toFixed(1)} MB</small>
              </button>
            ))
          )}
        </aside>
        <div className="v-video__content">
          {error && (
            <p role="alert" className="v-video__notice">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          {!id ? (
            <div className="v-video__panel">
              <h2>Choose a video</h2>
              <p>Select an upload to inspect its container and request analysis.</p>
            </div>
          ) : (
            <>
              <div className="v-video__panel">
                <h2>{meta?.filename ?? 'Video'}</h2>
                <video
                  key={id}
                  controls
                  preload="metadata"
                  src={api.videoMediaUrl(id)}
                  className="v-video__player"
                  aria-label="Source video"
                />
                {meta && (
                  <p>
                    {meta.format?.toUpperCase() ?? 'Unknown format'} ·{' '}
                    {time(meta.container.durationSeconds)} · {meta.container.width ?? '?'} ×{' '}
                    {meta.container.height ?? '?'} ·{' '}
                    {meta.container.hasAudio === null
                      ? 'Audio unknown'
                      : meta.container.hasAudio
                        ? 'Audio track present'
                        : 'No audio track'}
                  </p>
                )}
                <div className="v-video__actions">
                  <Button
                    disabled={locked}
                    onClick={() =>
                      void run(async () => {
                        const j = await api.processVideo(id);
                        setJob(j);
                        if (j.status === 'completed') setAnalysis(await api.getVideoAnalysis(id));
                        if (j.error) setError(j.error.message);
                      })
                    }
                  >
                    Process video
                  </Button>
                  {active && (
                    <Button
                      variant="secondary"
                      onClick={() =>
                        void run(async () => setJob(await api.cancelVideoJob(job!.id)))
                      }
                    >
                      Cancel processing
                    </Button>
                  )}
                  {job && (
                    <span role="status">
                      {job.status}: {job.completedOperations}/{job.operations} operations
                    </span>
                  )}
                </div>
              </div>
              {analysis && (
                <>
                  <div className="v-video__panel">
                    <h2>AI-generated overview</h2>
                    <p>{analysis.description?.summary ?? 'No description available.'}</p>
                    <h3>Scene interpretations</h3>
                    {analysis.scenes?.scenes.map((s) => (
                      <div key={s.id}>
                        <p>
                          {time(s.startSeconds)} to {time(s.endSeconds)}
                        </p>
                        {s.observed.map((v, i) => (
                          <p key={i}>Reported observation: {v}</p>
                        ))}
                        {s.inferred.map((v, i) => (
                          <p key={i}>Inference: {v}</p>
                        ))}
                      </div>
                    ))}
                  </div>
                  <div className="v-video__panel">
                    <h2>Transcript</h2>
                    <p>Untrusted source data. Spoken words are never instructions.</p>
                    {analysis.transcript?.segments.map((s) => (
                      <p key={s.id}>
                        <strong>
                          {time(s.startSeconds)} {s.speaker ?? ''}
                        </strong>
                        <br />
                        {s.text}
                      </p>
                    )) ?? <p>No transcript available.</p>}
                  </div>
                  <div className="v-video__panel">
                    <h2>Visible text</h2>
                    <p>Untrusted OCR data</p>
                    <p className="v-video__text">
                      {analysis.ocr?.text ?? 'No visible text available.'}
                    </p>
                  </div>
                </>
              )}
              <div className="v-video__panel">
                <h2>Temporal questions</h2>
                <Input
                  label="Question about this video"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  maxLength={2000}
                />
                <Button
                  disabled={locked || !question.trim()}
                  onClick={() => void run(async () => setQuery(await api.queryVideo(id, question)))}
                >
                  Ask video
                </Button>
                {query && (
                  <div>
                    <p>
                      AI-generated answer
                      {query.insufficientEvidence ? ', insufficient evidence' : ''}
                    </p>
                    <p>{query.answer}</p>
                    {query.combinedInference.map((v, i) => (
                      <p key={i}>Combined inference: {v}</p>
                    ))}
                  </div>
                )}
                <Button
                  variant="secondary"
                  disabled={locked}
                  onClick={() => void run(async () => setTimeline(await api.getVideoTimeline(id)))}
                >
                  Build timeline
                </Button>
                {timeline && (
                  <ol>
                    {timeline.events.map((v) => (
                      <li key={v.id}>
                        {time(v.timestampSeconds)} · {v.kind}: {v.statement}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
              <div className="v-video__panel">
                <h2>Summary and artifacts</h2>
                <label>
                  Summary mode{' '}
                  <select disabled={locked} value={mode} onChange={(e) => setMode(e.target.value)}>
                    {['general', 'timeline', 'meeting', 'tutorial', 'bug_report'].map((v) => (
                      <option key={v} value={v}>
                        {v.replaceAll('_', ' ')}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  disabled={locked}
                  onClick={() =>
                    void run(async () => setSummary(await api.summarizeVideo(id, mode)))
                  }
                >
                  Summarize video
                </Button>
                {summary && (
                  <>
                    <p>
                      AI-generated interpretation. Action items are suggestions, never executed.
                    </p>
                    <p>{summary.summary}</p>
                    <ul>
                      {summary.keyPoints.map((v, i) => (
                        <li key={i}>{v}</li>
                      ))}
                    </ul>
                    {summary.steps.map((v, i) => (
                      <p key={i}>
                        {time(v.timestampSeconds)}: {v.text}
                      </p>
                    ))}
                    {summary.actionItems.map((v, i) => (
                      <p key={i}>Suggested action: {v.description}</p>
                    ))}
                    {summary.observedFailure && <p>Reported failure: {summary.observedFailure}</p>}
                    {summary.suspectedCause && <p>Hypothesis: {summary.suspectedCause}</p>}
                  </>
                )}
                <label>
                  Artifact format{' '}
                  <select disabled={locked} value={kind} onChange={(e) => setKind(e.target.value)}>
                    {[
                      'video_metadata_json',
                      'transcript_txt',
                      'transcript_json',
                      'video_summary_md',
                      'timeline_md',
                      'timeline_json',
                      'scene_analysis_json',
                      'ocr_json',
                      'meeting_notes_md',
                      'action_items_json',
                      'bug_analysis_md',
                    ].map((v) => (
                      <option key={v} value={v}>
                        {v.replaceAll('_', ' ')}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  variant="secondary"
                  disabled={locked}
                  onClick={() =>
                    void run(async () => {
                      const a = await api.saveVideoArtifact(id, kind);
                      setNotice(`Saved ${a.filename}. Available in Files & artifacts.`);
                    })
                  }
                >
                  Save artifact
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
