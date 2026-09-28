import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Badge, Button, ErrorState, Input, Spinner } from '../components/ui';
import { errorMessage } from '../api/client';
import { listFiles, uploadFile, type FileView } from '../api/files';
import {
  cancelAudioJob,
  getAudioAnalysis,
  getAudioCapabilities,
  getAudioJob,
  getAudioTranscript,
  processAudio,
  queryAudio,
  saveAudioArtifact,
  searchAudio,
  summarizeAudio,
  translateAudio,
  audioMediaUrl,
  type AudioAnalysisView,
  type AudioCapabilitiesView,
  type AudioJobView,
  type AudioQueryView,
  type AudioSearchView,
  type AudioSummaryView,
  type AudioTranscriptView,
  type AudioTranslationView,
} from '../api/audio';
import { getDownloadReference } from '../api/files';

const formatTime = (seconds: number | null) => {
  if (seconds === null) return '--:--';
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
};
const formatBytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;

const TERMINAL = ['completed', 'failed', 'cancelled', 'expired'];

export function AudioPage() {
  const [files, setFiles] = useState<readonly FileView[]>([]);
  const [capabilities, setCapabilities] = useState<AudioCapabilitiesView | null>(null);
  const [selected, setSelected] = useState<FileView | null>(null);
  const [transcript, setTranscript] = useState<AudioTranscriptView | null>(null);
  const [job, setJob] = useState<AudioJobView | null>(null);
  const [summary, setSummary] = useState<AudioSummaryView | null>(null);
  const [analysis, setAnalysis] = useState<AudioAnalysisView | null>(null);
  const [queryResult, setQueryResult] = useState<AudioQueryView | null>(null);
  const [searchResult, setSearchResult] = useState<AudioSearchView | null>(null);
  const [translation, setTranslation] = useState<AudioTranslationView | null>(null);
  const [question, setQuestion] = useState('');
  const [searchText, setSearchText] = useState('');
  const [language, setLanguage] = useState('');
  const [targetLanguage, setTargetLanguage] = useState('fr');
  const [projectId, setProjectId] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedArtifact, setSavedArtifact] = useState<{ id: string; filename: string } | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const load = async () => {
    setFailure(null);
    try {
      const all = await listFiles('');
      setFiles(all.filter((f) => f.category === 'audio'));
    } catch (e) {
      setFailure(errorMessage(e));
    }
  };
  useEffect(() => {
    void load();
    void getAudioCapabilities()
      .then(setCapabilities)
      .catch(() => undefined);
  }, []);

  // Poll the active job until it reaches a terminal state.
  useEffect(() => {
    if (!job || TERMINAL.includes(job.status)) return;
    const timer = setInterval(async () => {
      try {
        const updated = await getAudioJob(job.id);
        setJob(updated);
      } catch {
        /* stop polling on missing job */
      }
    }, 400);
    return () => clearInterval(timer);
  }, [job]);

  // When the job completes, fetch the transcript.
  useEffect(() => {
    if (!job || job.status !== 'completed' || !selected) return;
    void getAudioTranscript(selected.id)
      .then(setTranscript)
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
    setTranscript(null);
    setSummary(null);
    setAnalysis(null);
    setQueryResult(null);
    setSearchResult(null);
    setTranslation(null);
    setSavedArtifact(null);
    setFailure(null);
    void getAudioTranscript(file.id)
      .then(setTranscript)
      .catch(() => setTranscript(null));
  };

  const startProcessing = async () => {
    if (!selected) return;
    setBusy(true);
    setFailure(null);
    try {
      const started = await processAudio(selected.id, language.trim() || undefined);
      setJob(started);
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const cancelProcessing = async () => {
    if (!job) return;
    try {
      setJob(await cancelAudioJob(job.id));
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
  const doSummarize = () =>
    runAction(async () => {
      const style = document.querySelector<HTMLSelectElement>('#v-audio-style')?.value ?? 'short';
      setSummary(await summarizeAudio(selected?.id ?? '', style));
    });
  const doExtract = () =>
    runAction(async () => {
      setAnalysis(await getAudioAnalysis(selected?.id ?? ''));
    });
  const doQuery = () =>
    runAction(async () => {
      setQueryResult(await queryAudio(selected?.id ?? '', question));
    });
  const doSearch = () =>
    runAction(async () => {
      setSearchResult(await searchAudio(selected?.id ?? '', searchText));
    });
  const doTranslate = () =>
    runAction(async () => {
      setTranslation(
        await translateAudio(selected?.id ?? '', { targetLanguage, scope: 'transcript' }),
      );
    });
  const doSaveArtifact = (kind: string) =>
    runAction(async () => {
      const artifact = await saveAudioArtifact(selected?.id ?? '', {
        kind,
        ...(translation && kind === 'translation_md'
          ? {
              translation: {
                translatedText: translation.translatedText,
                targetLanguage: translation.targetLanguage,
                scope: translation.scope,
              },
            }
          : {}),
      });
      setSavedArtifact({ id: artifact.id, filename: artifact.filename });
    });
  const doDownload = () =>
    runAction(async () => {
      if (!savedArtifact) return;
      const ref = await getDownloadReference(savedArtifact.id);
      window.location.assign(ref.downloadUrl);
    });

  const seekTo = (seconds: number | null) => {
    const audio = audioRef.current;
    if (!audio || seconds === null) return;
    audio.currentTime = seconds;
    void audio.play();
  };

  return (
    <div className="v-page">
      <header className="v-page__header">
        <h2>Audio intelligence</h2>
        <p className="v-page__subtitle">
          Transcribe and reason over authorized audio. Spoken content stays data - it never becomes
          an instruction.{' '}
          {capabilities?.providerIsSimulation ? (
            <span className="v-audio__sim">
              Development provider: deterministic mock simulation.
            </span>
          ) : null}
        </p>
      </header>
      {failure ? <ErrorState description={failure} /> : null}
      <div className="v-audio">
        <section className="v-audio__files" aria-label="Audio files">
          <div className="v-audio__upload">
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
                accept="audio/*,.mp3,.wav,.ogg,.m4a,.flac,.aac"
                onChange={onUpload}
              />
              {busy ? <Spinner aria-label="Working" /> : 'Upload audio'}
            </label>
          </div>
          <ul className="v-audio__list">
            {files.length === 0 ? (
              <li className="v-audio__empty">No audio files yet. Upload one to begin.</li>
            ) : (
              files.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    className={`v-audio__file${selected?.id === f.id ? ' is-selected' : ''}`}
                    onClick={() => selectFile(f)}
                  >
                    <span className="v-audio__file-name">{f.filename}</span>
                    <span className="v-audio__file-meta">
                      {formatBytes(f.size)}
                      {f.durationSeconds !== null ? ` · ${formatTime(f.durationSeconds)}` : ''}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </section>
        {selected ? (
          <section className="v-audio__main" aria-label="Audio workspace">
            <div className="v-audio__player">
              <h3>{selected.filename}</h3>
              <audio
                ref={audioRef}
                controls
                preload="metadata"
                src={audioMediaUrl(selected.id)}
                aria-label="Audio player"
              />
              <div className="v-audio__process">
                <label className="v-field">
                  <span>Language (optional)</span>
                  <Input
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    placeholder="auto"
                    aria-label="Spoken language"
                  />
                </label>
                <Button onClick={startProcessing} disabled={busy}>
                  Process audio
                </Button>
                {job && !TERMINAL.includes(job.status) ? (
                  <Button variant="secondary" onClick={cancelProcessing}>
                    Cancel
                  </Button>
                ) : null}
              </div>
              {job ? (
                <p className="v-audio__job" role="status">
                  Job {job.status} ({job.stage}) · chunks {job.completedChunks}/{job.chunks}
                  {job.error ? ` · ${job.error.message}` : ''}
                </p>
              ) : null}
            </div>
            {transcript ? (
              <div className="v-audio__transcript">
                <h4>Transcript</h4>
                <p className="v-audio__trust">
                  <Badge>untrusted data</Badge>{' '}
                  {transcript.providerIsSimulation ? 'Mock simulation' : 'Provider output'} ·
                  language {transcript.language ?? 'unknown'}
                  {transcript.timestampsAvailable ? ' · timestamps available' : ' · no timestamps'}
                </p>
                <ol className="v-audio__segments">
                  {transcript.segments.map((segment) => (
                    <li key={segment.id} className="v-audio__segment">
                      <button
                        type="button"
                        className="v-audio__segment-button"
                        onClick={() => seekTo(segment.startSeconds)}
                        aria-label={`Jump to ${formatTime(segment.startSeconds)}`}
                      >
                        <span className="v-audio__segment-time">
                          {formatTime(segment.startSeconds)}
                        </span>
                        <span className="v-audio__segment-speaker">
                          {segment.speaker ?? 'Unknown speaker'}
                        </span>
                        <span className="v-audio__segment-text">{segment.text}</span>
                      </button>
                    </li>
                  ))}
                </ol>
                <div className="v-audio__actions">
                  <div className="v-audio__action-row">
                    <Input
                      value={searchText}
                      onChange={(e) => setSearchText(e.target.value)}
                      placeholder="Search the transcript…"
                      aria-label="Search transcript"
                    />
                    <Button
                      variant="secondary"
                      onClick={doSearch}
                      disabled={busy || !searchText.trim()}
                    >
                      Search
                    </Button>
                  </div>
                  <div className="v-audio__action-row">
                    <Input
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      placeholder="Ask about this recording…"
                      aria-label="Ask about this recording"
                    />
                    <Button
                      variant="secondary"
                      onClick={doQuery}
                      disabled={busy || !question.trim()}
                    >
                      Ask
                    </Button>
                  </div>
                  <div className="v-audio__action-row">
                    <select id="v-audio-style" className="v-select" aria-label="Summary style">
                      <option value="short">Short summary</option>
                      <option value="detailed">Detailed summary</option>
                      <option value="meeting">Meeting summary</option>
                      <option value="executive">Executive summary</option>
                      <option value="key_points">Key points</option>
                      <option value="chronological">Chronological</option>
                    </select>
                    <Button variant="secondary" onClick={doSummarize} disabled={busy}>
                      Summarize
                    </Button>
                    <Button variant="secondary" onClick={doExtract} disabled={busy}>
                      Extract info
                    </Button>
                  </div>
                  <div className="v-audio__action-row">
                    <Input
                      value={targetLanguage}
                      onChange={(e) => setTargetLanguage(e.target.value)}
                      placeholder="en, fr, yo…"
                      aria-label="Target language"
                    />
                    <Button variant="secondary" onClick={doTranslate} disabled={busy}>
                      Translate transcript
                    </Button>
                  </div>
                </div>
                {searchResult ? (
                  <div className="v-audio__result">
                    <h5>Search results ({searchResult.matches.length})</h5>
                    <Badge>untrusted data</Badge>
                    <ul>
                      {searchResult.matches.map((m) => (
                        <li key={m.segment.id}>
                          <button
                            type="button"
                            className="v-audio__link"
                            onClick={() => seekTo(m.segment.startSeconds)}
                          >
                            {formatTime(m.segment.startSeconds)} · {m.segment.speaker ?? '?'} ·{' '}
                            {m.segment.text}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {queryResult ? (
                  <div className="v-audio__result">
                    <h5>Answer</h5>
                    <Badge>ai-generated</Badge>
                    {queryResult.providerIsSimulation ? ' Mock simulation' : null}
                    <p>{queryResult.answer}</p>
                    {queryResult.supportingSegments.length > 0 ? (
                      <ul className="v-audio__evidence">
                        {queryResult.supportingSegments.map((s) => (
                          <li key={s.id}>
                            {formatTime(s.startSeconds)} — {s.text}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
                {summary ? (
                  <div className="v-audio__result">
                    <h5>Summary ({summary.style})</h5>
                    <Badge>ai-generated</Badge>
                    <p>{summary.text}</p>
                    {summary.keyPoints.length > 0 ? (
                      <ul>
                        {summary.keyPoints.map((k, i) => (
                          <li key={i}>{k}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
                {analysis ? (
                  <div className="v-audio__result">
                    <h5>Extracted information</h5>
                    <Badge>ai-generated</Badge>
                    {analysis.decisions.length > 0 ? (
                      <>
                        <h6>Decisions</h6>
                        <ul>
                          {analysis.decisions.map((d, i) => (
                            <li key={i}>
                              {d.statement} <em>({d.certainty})</em>
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                    {analysis.actionItems.length > 0 ? (
                      <>
                        <h6>Action items (suggestions only)</h6>
                        <ul>
                          {analysis.actionItems.map((a, i) => (
                            <li key={i}>
                              {a.description}
                              {a.assignedTo ? ` — ${a.assignedTo}` : ''}
                              {a.deadline ? ` (by ${a.deadline})` : ''}
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                    {analysis.entities.length > 0 ? (
                      <>
                        <h6>Entities</h6>
                        <ul>
                          {analysis.entities.map((e, i) => (
                            <li key={i}>
                              {e.field}: {e.value}
                              {e.uncertain ? ' (uncertain)' : ''}
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                  </div>
                ) : null}
                {translation ? (
                  <div className="v-audio__result">
                    <h5>Translation ({translation.targetLanguage})</h5>
                    <Badge>ai-generated</Badge>
                    <p>{translation.translatedText}</p>
                    <p className="v-audio__trust">
                      The original transcript is preserved separately.
                    </p>
                  </div>
                ) : null}
                <div className="v-audio__artifacts">
                  <Button
                    variant="secondary"
                    onClick={() => doSaveArtifact('transcript_md')}
                    disabled={busy}
                  >
                    Save transcript artifact
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => doSaveArtifact('summary_md')}
                    disabled={busy}
                  >
                    Save summary artifact
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => doSaveArtifact('meeting_notes_md')}
                    disabled={busy}
                  >
                    Save meeting notes
                  </Button>
                  {translation ? (
                    <Button
                      variant="secondary"
                      onClick={() => doSaveArtifact('translation_md')}
                      disabled={busy}
                    >
                      Save translation artifact
                    </Button>
                  ) : null}
                  {savedArtifact ? (
                    <span className="v-audio__saved" role="status">
                      Saved {savedArtifact.filename} ·{' '}
                      <Button variant="secondary" onClick={doDownload}>
                        Download artifact
                      </Button>
                    </span>
                  ) : null}
                </div>
              </div>
            ) : job && TERMINAL.includes(job.status) && job.status !== 'completed' ? (
              <p className="v-audio__job">Processing did not complete ({job.status}).</p>
            ) : (
              <p className="v-audio__hint">Process this file to produce a transcript.</p>
            )}
          </section>
        ) : (
          <section className="v-audio__main v-audio__hint" aria-label="Audio workspace">
            Select an audio file to begin.
          </section>
        )}
      </div>
    </div>
  );
}
