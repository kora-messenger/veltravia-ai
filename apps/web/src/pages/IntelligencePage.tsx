import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input } from '../components/ui';
import { errorMessage } from '../api/client';
import * as api from '../api/intelligence';

/** Knowledge synthesis (Step 25).
 *
 * The page is deliberately explicit about what produced an answer: every result
 * carries its reasoning disclosure, every claim links to the passage it came
 * from, and conflicts are shown as conflicts instead of being resolved by the
 * interface. No source content is ever edited here.
 */
export function IntelligencePage() {
  const [capabilities, setCapabilities] = useState<api.IntelligenceCapabilities | null>(null);
  const [sources, setSources] = useState<api.SourcesResponse | null>(null);
  const [question, setQuestion] = useState('');
  const [filter, setFilter] = useState('');
  const [answer, setAnswer] = useState<api.SynthesisAnswer | null>(null);
  const [comparison, setComparison] = useState<api.ComparisonResult | null>(null);
  const [selectedSources, setSelectedSources] = useState<readonly string[]>([]);
  const [openEvidence, setOpenEvidence] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingSources, setLoadingSources] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadSources = useCallback(async () => {
    setLoadingSources(true);
    try {
      const [caps, list] = await Promise.all([
        api.getCapabilities().catch(() => null),
        api.listSources(),
      ]);
      setCapabilities(caps);
      setSources(list);
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingSources(false);
    }
  }, []);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  const visibleSources = useMemo(() => {
    const all = sources?.sources ?? [];
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) return all;
    return all.filter(
      (source) =>
        source.name.toLowerCase().includes(needle) ||
        source.providerName.toLowerCase().includes(needle),
    );
  }, [sources, filter]);

  const evidenceById = useMemo(() => {
    const map = new Map<string, api.EvidenceView>();
    for (const item of answer?.evidence ?? []) map.set(item.evidenceId, item);
    return map;
  }, [answer]);

  const runAnalysis = async () => {
    const text = question.trim();
    if (text.length === 0) {
      setError('Ask a question first.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    setComparison(null);
    try {
      const result = await api.analyze(text);
      setAnswer(result);
      if (result.status === 'no_evidence')
        setNotice('Nothing matched this question, so no answer was produced.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const runComparison = async () => {
    if (selectedSources.length < 2) {
      setError('Pick at least two sources to compare.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    setAnswer(null);
    try {
      setComparison(await api.compare(selectedSources));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleSource = (sourceId: string) => {
    setSelectedSources((current) =>
      current.includes(sourceId)
        ? current.filter((id) => id !== sourceId)
        : current.length >= 5
          ? current
          : [...current, sourceId],
    );
  };

  const unavailable = (sources?.providers ?? []).filter((provider) => !provider.available);

  return (
    <div className="v-page">
      <header className="v-page__header">
        <div>
          <h1 className="v-page__title">Knowledge synthesis</h1>
          <p className="v-page__subtitle">
            One question across your uploaded documents, connected apps and project files. Every
            statement is tied to a source, and conflicts stay visible.
          </p>
        </div>
        <Button variant="secondary" onClick={() => void loadSources()} disabled={loadingSources}>
          {loadingSources ? 'Refreshing…' : 'Refresh sources'}
        </Button>
      </header>

      {capabilities !== null && (
        <div className={`v-banner v-banner--${capabilities.reasoning.simulated ? 'info' : 'ok'}`}>
          <strong>Reasoning: {capabilities.reasoning.mode.replace(/_/g, ' ')}</strong>
          <span>{capabilities.reasoning.detail}</span>
        </div>
      )}

      {unavailable.length > 0 && (
        <div className="v-banner v-banner--warn">
          <strong>Not searched</strong>
          <span>
            {unavailable.map((provider) => `${provider.provider}: ${provider.detail}`).join(' · ')}
          </span>
        </div>
      )}

      {error !== '' && (
        <p className="v-error" role="alert">
          {error}
        </p>
      )}
      {notice !== '' && <p className="v-hint">{notice}</p>}

      <section className="v-card" aria-labelledby="intelligence-ask">
        <h2 id="intelligence-ask" className="v-card__title">
          Ask across everything
        </h2>
        <label className="v-field">
          <span className="v-field__label">Question</span>
          <Input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="What changed about the authentication plan?"
            maxLength={500}
          />
          <span className="v-field__hint">
            Answers are assembled from retrieved passages. Nothing is invented to fill a gap.
          </span>
        </label>
        <div className="v-actions">
          <Button onClick={() => void runAnalysis()} disabled={busy}>
            {busy ? 'Working…' : 'Analyze sources'}
          </Button>
        </div>
      </section>

      <section className="v-card" aria-labelledby="intelligence-sources">
        <h2 id="intelligence-sources" className="v-card__title">
          Sources ({visibleSources.length})
        </h2>
        <label className="v-field">
          <span className="v-field__label">Filter sources</span>
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter by name or provider"
          />
        </label>
        {loadingSources ? (
          <p className="v-hint">Loading sources…</p>
        ) : visibleSources.length === 0 ? (
          <p className="v-hint">
            No sources yet. Upload a document, connect an app, or add a project file.
          </p>
        ) : (
          <ul className="v-list" aria-label="Authorized sources">
            {visibleSources.map((source) => (
              <li key={source.sourceId} className="v-list__item">
                <label className="v-check">
                  <input
                    type="checkbox"
                    checked={selectedSources.includes(source.sourceId)}
                    onChange={() => toggleSource(source.sourceId)}
                    aria-label={`Select ${source.name} for comparison`}
                  />
                  <span>
                    <strong>{source.name}</strong>{' '}
                    <span className="v-tag">{source.providerName}</span>{' '}
                    <span className="v-tag v-tag--muted">
                      {source.sourceType.replace(/_/g, ' ')}
                    </span>{' '}
                    {source.freshness.stale && <span className="v-tag v-tag--warn">stale</span>}{' '}
                    <span className="v-tag v-tag--muted">untrusted data</span>
                    <br />
                    <span className="v-hint">
                      revision {source.contentVersion} · retrieved{' '}
                      {new Date(source.retrievedAt).toLocaleString()}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <div className="v-actions">
          <Button
            variant="secondary"
            onClick={() => void runComparison()}
            disabled={busy || selectedSources.length < 2}
          >
            Compare selected ({selectedSources.length})
          </Button>
        </div>
      </section>

      {answer !== null && (
        <section className="v-card" aria-labelledby="intelligence-answer">
          <h2 id="intelligence-answer" className="v-card__title">
            Answer
          </h2>
          <p className={`v-tag v-tag--${answer.status === 'answered' ? 'ok' : 'warn'}`}>
            {answer.status.replace(/_/g, ' ')} · intent {answer.intent} · {answer.sources.length}{' '}
            sources · {answer.evidence.length} cited passages
          </p>
          <p>{answer.summary}</p>
          <p className="v-hint">
            Reasoning: {answer.reasoning.mode.replace(/_/g, ' ')} — {answer.reasoning.detail}
          </p>

          {answer.claims.length > 0 && (
            <>
              <h3 className="v-card__subtitle">Claims</h3>
              <ul className="v-list">
                {answer.claims.map((claim) => (
                  <li key={claim.claimId} className="v-list__item">
                    <p>{claim.statement}</p>
                    <p className="v-hint">
                      <span className="v-tag v-tag--muted">{claim.kind.replace(/_/g, ' ')}</span>{' '}
                      confidence {(claim.confidence * 100).toFixed(0)}%
                      {claim.evidenceIds.length === 0 && ' · no citable evidence'}
                    </p>
                    {claim.evidenceIds.map((evidenceId) => {
                      const item = evidenceById.get(evidenceId);
                      if (!item) return null;
                      const open = openEvidence === evidenceId;
                      return (
                        <div key={evidenceId} className="v-evidence">
                          <Button
                            variant="ghost"
                            onClick={() => setOpenEvidence(open ? null : evidenceId)}
                            aria-expanded={open}
                          >
                            {open ? 'Hide passage' : `Show passage (${item.locator.label})`}
                          </Button>
                          {open && (
                            <blockquote className="v-quote">
                              {item.excerpt}
                              <footer className="v-hint">
                                {item.resourceName} · revision {item.revision} · retrieved{' '}
                                {new Date(item.retrievedAt).toLocaleString()}
                              </footer>
                            </blockquote>
                          )}
                        </div>
                      );
                    })}
                  </li>
                ))}
              </ul>
            </>
          )}

          {answer.contradictions.length > 0 && (
            <>
              <h3 className="v-card__subtitle">Conflicts ({answer.contradictions.length})</h3>
              <ul className="v-list">
                {answer.contradictions.map((conflict) => (
                  <li key={conflict.contradictionId} className="v-list__item">
                    <p>
                      <span className="v-tag v-tag--warn">{conflict.kind.replace(/_/g, ' ')}</span>{' '}
                      {conflict.topic}
                    </p>
                    <p>{conflict.explanation}</p>
                    <ul>
                      {conflict.statements.map((statement) => (
                        <li key={`${conflict.contradictionId}:${statement.evidenceId}`}>
                          {statement.text}{' '}
                          <span className="v-hint">
                            — {statement.resourceName}, revision {statement.revision}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {conflict.resolution !== null && (
                      <p className="v-hint">{conflict.resolution}</p>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}

          {answer.gaps.length > 0 && (
            <>
              <h3 className="v-card__subtitle">Missing information</h3>
              <ul className="v-list">
                {answer.gaps.map((gap) => (
                  <li key={gap.gapId} className="v-list__item">
                    <span className="v-tag v-tag--muted">{gap.kind.replace(/_/g, ' ')}</span>{' '}
                    {gap.description}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {comparison !== null && (
        <section className="v-card" aria-labelledby="intelligence-compare">
          <h2 id="intelligence-compare" className="v-card__title">
            Comparison
          </h2>
          <p className="v-hint">
            {comparison.participants.length} sources · {comparison.agreements.length} shared points
            · {comparison.contradictions.length} conflicts
          </p>
          <ul className="v-list">
            {comparison.participants.map((participant) => (
              <li key={participant.source.sourceId} className="v-list__item">
                <strong>{participant.source.name}</strong>{' '}
                <span className="v-hint">
                  {participant.wordCount} words · revision {participant.source.contentVersion}
                </span>
                {participant.outline.length > 0 && (
                  <p className="v-hint">Sections: {participant.outline.join(', ')}</p>
                )}
              </li>
            ))}
          </ul>
          {comparison.agreements.length > 0 && (
            <>
              <h3 className="v-card__subtitle">Shared</h3>
              <ul className="v-list">
                {comparison.agreements.map((claim) => (
                  <li key={claim.claimId} className="v-list__item">
                    {claim.statement}
                  </li>
                ))}
              </ul>
            </>
          )}
          {comparison.contradictions.length > 0 && (
            <>
              <h3 className="v-card__subtitle">Conflicts</h3>
              <ul className="v-list">
                {comparison.contradictions.map((conflict) => (
                  <li key={conflict.contradictionId} className="v-list__item">
                    <p>{conflict.explanation}</p>
                    <ul>
                      {conflict.statements.map((statement) => (
                        <li key={`${conflict.contradictionId}:c:${statement.evidenceId}`}>
                          {statement.text}{' '}
                          <span className="v-hint">— {statement.resourceName}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <section className="v-card" aria-labelledby="intelligence-scope">
        <h2 id="intelligence-scope" className="v-card__title">
          What this can and cannot do
        </h2>
        <ul className="v-list">
          <li className="v-list__item">
            Reads your uploaded files, connected-app resources and project workspace files. It never
            writes to them.
          </li>
          <li className="v-list__item">
            Answers are extracted and assembled from retrieved passages. A mock or structural
            provider is used here, so wording is template-based rather than model-written.
          </li>
          <li className="v-list__item">
            Conflicts are reported, not resolved. Where the evidence settles a question (an explicit
            supersession), the resolution is stated with the sources behind it.
          </li>
          <li className="v-list__item">
            Sources marked stale are older than the freshness window and should be re-checked before
            relying on them.
          </li>
        </ul>
        <p className="v-hint">
          {selectedSources.length === 0
            ? 'Select two to five sources above to enable the comparison.'
            : `${selectedSources.length} source${selectedSources.length === 1 ? '' : 's'} selected for comparison.`}
        </p>
      </section>
    </div>
  );
}
