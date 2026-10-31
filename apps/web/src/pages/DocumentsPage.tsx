import { useEffect, useRef, useState } from 'react';
import { Button, Input } from '../components/ui';
import { listFiles, uploadFile, type FileView } from '../api/files';
import { errorMessage } from '../api/client';
import * as api from '../api/documents';

const DOCUMENT_CATEGORIES = ['document', 'spreadsheet', 'text'];
const SUMMARY_MODES = [
  { value: 'brief', label: 'Brief' },
  { value: 'bullets', label: 'Bullets' },
  { value: 'executive', label: 'Executive' },
] as const;

export function DocumentsPage() {
  const [files, setFiles] = useState<readonly FileView[]>([]);
  const [id, setId] = useState('');
  const [meta, setMeta] = useState<api.DocumentInspection | null>(null);
  const [structure, setStructure] = useState<api.DocumentStructure | null>(null);
  const [answer, setAnswer] = useState<api.DocumentAnswer | null>(null);
  const [summary, setSummary] = useState<api.DocumentSummary | null>(null);
  const [entities, setEntities] = useState<api.DocumentEntities | null>(null);
  const [search, setSearch] = useState<api.DocumentSearchResult | null>(null);
  const [sheetView, setSheetView] = useState<api.SpreadsheetView | null>(null);
  const [deckView, setDeckView] = useState<api.PresentationView | null>(null);
  const [simulation, setSimulation] = useState<boolean | null>(null);
  const [question, setQuestion] = useState('');
  const [query, setQuery] = useState('');
  const [summaryMode, setSummaryMode] = useState<string>('brief');
  const [artifactKind, setArtifactKind] = useState('document_text_md');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);

  useEffect(() => {
    let live = true;
    Promise.all([listFiles(), api.getDocumentCapabilities()])
      .then(([f, c]) => {
        if (!live) return;
        setFiles(f.filter((v) => DOCUMENT_CATEGORIES.includes(v.category)));
        setSimulation(c.providerIsSimulation);
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
    setStructure(null);
    setAnswer(null);
    setSummary(null);
    setEntities(null);
    setSearch(null);
    setSheetView(null);
    setDeckView(null);
    setError('');
    setNotice('');
    if (!id) return;
    api
      .inspectDocument(id)
      .then((v) => {
        if (g === generation.current) setMeta(v);
      })
      .catch((e) => {
        if (g === generation.current) setError(errorMessage(e));
      });
    return () => {
      generation.current++;
    };
  }, [id]);

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

  const process = () =>
    run(async () => {
      const job = await api.processDocument(id);
      if (job.status === 'completed') {
        setStructure(await api.getDocumentStructure(id));
        setNotice('Document processed. Extracted text and tables are untrusted content.');
      } else {
        setError(job.error?.message ?? 'Processing did not complete.');
      }
    });

  return (
    <section className="v-page">
      <header className="v-page__header">
        <div>
          <h1 className="v-page__title">Documents</h1>
          <p className="v-page__subtitle">
            Read structure, search text, ask questions and export what you find.
          </p>
        </div>
      </header>
      {simulation !== null && (
        <p className="v-video__notice">
          {simulation
            ? 'Parsing is real. Reasoning answers come from a deterministic simulation, not a real document model.'
            : 'Provider-generated interpretation. Verify important claims against the source.'}
        </p>
      )}
      <div className="v-video__layout">
        <aside className="v-video__panel">
          <Input
            label="Upload document"
            type="file"
            accept=".pdf,.docx,.xlsx,.pptx,.csv,.md,.html,.json,.xml,.txt"
            disabled={busy}
            hint="Development uploads are limited to 25 MB."
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f)
                void run(async () => {
                  const v = await uploadFile(f, { projectId: null, workspaceId: null });
                  if (!DOCUMENT_CATEGORIES.includes(v.category))
                    throw new Error('This file was not identified as a document.');
                  setFiles(
                    (await listFiles()).filter((x) => DOCUMENT_CATEGORIES.includes(x.category)),
                  );
                  setId(v.id);
                });
              e.target.value = '';
            }}
          />
          <h2>Your documents</h2>
          {files.length === 0 ? (
            <p>No documents yet. Upload one to begin.</p>
          ) : (
            files.map((f) => (
              <button
                key={f.id}
                className="v-video__file"
                aria-pressed={f.id === id}
                disabled={busy}
                onClick={() => setId(f.id)}
              >
                {f.filename}
                <small>{(f.size / 1024).toFixed(0)} KB</small>
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
              <h2>Choose a document</h2>
              <p>Select an upload to inspect its format, then process it to read the content.</p>
            </div>
          ) : (
            <>
              <div className="v-video__panel">
                <h2>{files.find((f) => f.id === id)?.filename ?? 'Document'}</h2>
                {meta ? (
                  <p>
                    {meta.format.toUpperCase()} · {(meta.byteSize / 1024).toFixed(1)} KB · detected
                    from {meta.detectedFrom}
                  </p>
                ) : (
                  <p>Reading file metadata…</p>
                )}
                <div className="v-video__actions">
                  <Button disabled={busy} onClick={() => void process()}>
                    {structure ? 'Process again' : 'Process document'}
                  </Button>
                  {busy && <span role="status">Working…</span>}
                </div>
              </div>

              {!structure && !busy && (
                <div className="v-video__panel">
                  <h2>Not processed yet</h2>
                  <p>
                    Processing parses the file into headings, paragraphs, tables and sections. It
                    runs locally and changes nothing about the file.
                  </p>
                </div>
              )}

              {structure && (
                <>
                  <div className="v-video__panel">
                    <h2>Structure</h2>
                    <p>
                      {structure.elements.length} elements · {structure.tables.length} tables ·{' '}
                      {structure.sections.length} sections
                      {structure.pageCount !== null ? ` · ${structure.pageCount} pages` : ''}
                      {structure.slideCount !== null ? ` · ${structure.slideCount} slides` : ''}
                      {structure.sheetCount !== null ? ` · ${structure.sheetCount} sheets` : ''}
                    </p>
                    {structure.truncated && (
                      <p role="status">
                        This document is large; content was truncated at the limit.
                      </p>
                    )}
                    <h3>Sections</h3>
                    {structure.sections.length === 0 ? (
                      <p>No headings were detected in this document.</p>
                    ) : (
                      <ul>
                        {structure.sections.map((s) => (
                          <li key={s.id}>
                            {s.title || 'Untitled section'} — {s.elementIds.length} elements
                          </li>
                        ))}
                      </ul>
                    )}
                    <h3>Extracted text</h3>
                    <ul className="v-doc__elements">
                      {structure.elements.slice(0, 40).map((e) => (
                        <li key={e.id}>
                          <span className="v-doc__tag">{e.type}</span> {e.text.slice(0, 240)}
                        </li>
                      ))}
                    </ul>
                    {structure.elements.length > 40 && (
                      <p>Showing the first 40 of {structure.elements.length} elements.</p>
                    )}
                  </div>

                  <div className="v-video__panel">
                    <h2>Search</h2>
                    <Input
                      label="Find text"
                      value={query}
                      disabled={busy}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="revenue"
                    />
                    <div className="v-video__actions">
                      <Button
                        disabled={busy || query.trim().length === 0}
                        onClick={() =>
                          void run(async () => {
                            const r = await api.searchDocument(id, query.trim());
                            setSearch(r);
                            if (r.total === 0) setNotice('No matches in the extracted text.');
                          })
                        }
                      >
                        Search
                      </Button>
                    </div>
                    {search && (
                      <div>
                        <p>
                          {search.total} match{search.total === 1 ? '' : 'es'}
                          {search.truncated ? ' (truncated)' : ''}
                        </p>
                        <ul>
                          {search.matches.map((m) => (
                            <li key={m.elementId}>{m.snippet}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  <div className="v-video__panel">
                    <h2>Ask a question</h2>
                    <Input
                      label="Question"
                      value={question}
                      disabled={busy}
                      onChange={(e) => setQuestion(e.target.value)}
                      placeholder="What grew fastest?"
                    />
                    <div className="v-video__actions">
                      <Button
                        disabled={busy || question.trim().length === 0}
                        onClick={() =>
                          void run(async () =>
                            setAnswer(await api.askDocument(id, question.trim())),
                          )
                        }
                      >
                        Ask
                      </Button>
                    </div>
                    {answer && (
                      <div>
                        <p>{answer.answer}</p>
                        <p>Confidence: {answer.confidence} (AI-generated)</p>
                        <h3>Evidence</h3>
                        {answer.evidence.length === 0 ? (
                          <p>No quoted passage could be verified in this document.</p>
                        ) : (
                          <ul>
                            {answer.evidence.map((e) => (
                              <li key={`${e.ref.id}-${e.quote.slice(0, 20)}`}>
                                “{e.quote}” — {e.ref.label}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="v-video__panel">
                    <h2>Summarise</h2>
                    <div className="v-video__actions">
                      <select
                        aria-label="Summary mode"
                        value={summaryMode}
                        disabled={busy}
                        onChange={(e) => setSummaryMode(e.target.value)}
                      >
                        {SUMMARY_MODES.map((m) => (
                          <option key={m.value} value={m.value}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void run(async () =>
                            setSummary(await api.summarizeDocument(id, summaryMode)),
                          )
                        }
                      >
                        Summarise
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => setEntities(await api.getDocumentEntities(id)))
                        }
                      >
                        Extract entities
                      </Button>
                    </div>
                    {summary && <p>{summary.summary}</p>}
                    {entities && (
                      <>
                        <h3>Entities (AI-generated)</h3>
                        {entities.entities.length === 0 ? (
                          <p>No entities were identified.</p>
                        ) : (
                          <ul>
                            {entities.entities.map((e) => (
                              <li key={`${e.type}-${e.name}`}>
                                {e.name} <span className="v-doc__tag">{e.type}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </>
                    )}
                  </div>

                  {meta?.format === 'xlsx' && (
                    <div className="v-video__panel">
                      <h2>Sheets</h2>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => setSheetView(await api.getSpreadsheetView(id)))
                        }
                      >
                        Show sheets
                      </Button>
                      {sheetView &&
                        sheetView.sheets.map((s) => (
                          <div key={s.name}>
                            <h3>{s.name}</h3>
                            <p>
                              {s.rowCount} rows · {s.columnCount} columns · {s.formulaCells} formula
                              cells (recorded, never evaluated)
                            </p>
                            <p>{s.headers.join(' · ')}</p>
                          </div>
                        ))}
                    </div>
                  )}

                  {meta?.format === 'pptx' && (
                    <div className="v-video__panel">
                      <h2>Slides</h2>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => setDeckView(await api.getPresentationView(id)))
                        }
                      >
                        Show slides
                      </Button>
                      {deckView &&
                        deckView.slides.map((s) => (
                          <div key={s.index}>
                            <h3>
                              {s.index + 1}. {s.title}
                            </h3>
                            {s.bulletTexts.length > 0 && (
                              <ul>
                                {s.bulletTexts.map((b) => (
                                  <li key={b}>{b}</li>
                                ))}
                              </ul>
                            )}
                            {s.notes && <p>Speaker notes: {s.notes}</p>}
                          </div>
                        ))}
                    </div>
                  )}

                  <div className="v-video__panel">
                    <h2>Export</h2>
                    <div className="v-video__actions">
                      <select
                        aria-label="Export format"
                        value={artifactKind}
                        disabled={busy}
                        onChange={(e) => setArtifactKind(e.target.value)}
                      >
                        <option value="document_text_md">Text (Markdown)</option>
                        <option value="document_structure_json">Structure (JSON)</option>
                        <option value="document_tables_csv">Tables (CSV)</option>
                        <option value="document_summary_md">Summary (Markdown)</option>
                        <option value="document_entities_json">Entities (JSON)</option>
                        <option value="document_search_json">Search results (JSON)</option>
                      </select>
                      <Button
                        disabled={
                          busy || (artifactKind === 'document_search_json' && !query.trim())
                        }
                        onClick={() =>
                          void run(async () => {
                            const extra =
                              artifactKind === 'document_summary_md'
                                ? { mode: summaryMode }
                                : artifactKind === 'document_search_json'
                                  ? { query: query.trim() }
                                  : {};
                            const a = await api.saveDocumentArtifact(id, artifactKind, extra);
                            setNotice(`Saved ${a.filename} to your files.`);
                          })
                        }
                      >
                        Save export
                      </Button>
                    </div>
                    <p>Exports are regenerated from the current structure and saved to Files.</p>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
