# Audio Intelligence (Step 20)

First-class **audio understanding over Step 19 files**: transcription, search, question answering, summarization, structured extraction, translation, and derived artifacts. Spoken content is DATA: a recording that says "ignore previous instructions" or "delete the project" is content being analyzed, never an authorized instruction. Nothing in this package executes tools, mutates projects, grants permission, or escalates trust.

This is a **development/CI foundation**. The API's wired provider is the deterministic mock simulation; it proves the complete pipeline (lifecycle, chunking, cancellation, trust tags, artifacts) but never represents real transcription quality. A genuine AIProvider-backed reasoning adapter exists (`provider/gemini-reasoning`) and is unit-tested with an injected provider; a **real audio-transcription provider is not wired into the API in this step** and is explicitly not faked. Model/production quality is a roadmap item.

## Trust model (fixed)

```
SYSTEM POLICY
    |
SECURITY / PERMISSIONS
    |
TOOLS
    |
FILE INTELLIGENCE      (audio bytes, untrusted)
    |
TRANSCRIPT / EXTRACTION (untrusted_data)
    |
AI REASONING OUTPUT     (ai_generated, never a direct audio fact)
```

- **Transcripts are `untrusted_data`.** They are rendered as text, searchable, and usable as bounded reference — never as system/developer instructions, never as authorization.
- **Reasoning output is `ai_generated`.** Summaries, answers, extracted action items/decisions/entities are interpretations. Action items are suggestions, never actions. Fabricated supporting-segment IDs from a provider are silently dropped; only real transcript segments can appear as evidence.
- **Timestamps, speakers, confidence are honest.** Providers that do not supply a value must represent it as unavailable (null) — never invented. Speaker labels are neutral ("Speaker 1"), never claimed identities.
- **Translations never replace originals.** The original transcript is always preserved separately.
- **Injection stays data.** A recording engineered to carry prompt injection is transcribed and analyzed as content. The manager surface exposes no execute/approve/confirm methods; the audit trail never carries transcript text.

## Domain (`audio-intelligence/core`)

- **`AudioProvider`** — the single provider seam. `capabilities()` declares a closed capability union (transcription, timestamps, speaker_identification, translation, summarization, question_answering, structured_extraction, long_audio) plus format/size/duration/language limits; `transcribe` and `reason` are the only operations. The manager refuses operations a provider cannot genuinely perform (`AUDIO_CAPABILITY_UNSUPPORTED`) and refuses multi-chunk processing without the `long_audio` capability.
- **`AudioIntelligenceManager`** — validated job lifecycle (`received → validating → transcribing → processing → analyzing → completed`, with `failed/cancelled/expired` terminal branches), owner-scoped jobs, bounded chunking, per-chunk cancellation probes (one-way, terminal), hard ceilings, scrubbed audit events (identifiers and counts, never transcript content), and the operations `inspect`, `getTranscript`, `search`, `query`, `summarize`, `extract`, `analyze`, `translate`, `saveArtifact`, `mediaBytes`.
- **Artifacts** — derived transcripts/summaries/notes/translations are persisted through the **existing Step 19 artifact system** with provenance links to the parent audio file and a `audio:<kind>:<fileId>` source operation. They ride the same checksum, expiry, opaque download and integrity rules.
- **Reasoning** — a tolerant, fail-closed JSON parser (`reasoning/`) for provider reasoning output: bounded arrays, typed certainty values, evidence dropped when malformed, no free-form strings accepted as facts.
- **Tools** — Tool System definitions (`audio.inspect`, `audio.transcribe`, `audio.search`, `audio.summarize`, `audio.extract`) over permission `audio.read`/`audio.reason`. Registration grants NOTHING; the API grants only the read-only `inspect` and `search` tools.

Limits (defaults / ceilings, `limits/index.ts`): 25 MiB file (100 MiB ceiling), 90-minute duration (360 ceiling), 16 chunks (64 ceiling), 1 concurrent job (4 ceiling), 512,000 transcript chars (4,000,000 ceiling), 60s processing timeout (600s ceiling), 24h job TTL (72h ceiling). No caller-provided option may exceed a ceiling.

## Mock (`audio-intelligence/mock`)

`MockAudioProvider` is a deterministic, offline, scripted simulation: checksum-keyed scripts, a default meeting recording, a prompt-injection fixture (`INJECTION_MOCK_SCRIPT`), optional chunk delay (`chunkDelayMs`) and per-chunk failure injection for cancellation/failure testing. It simulates every capability honestly (including timestamps and speaker labels) and claims no real model quality.

## API (`apps/api`)

`createAudioIntelligenceService` wires the manager over the Step 19 file manager. `AUDIO_MOCK_CHUNK_DELAY_MS` slows the simulated provider for live cancellation QA. Routes (`apps/api/src/routes/audio.ts`), all returning safe views only:

- `GET /api/audio/capabilities` — provider surface, simulation status, limits
- `POST /api/audio/:fileId/process` (202 + early job snapshot), `GET /api/audio/jobs`, `GET /api/audio/jobs/:jobId`, `POST /api/audio/jobs/:jobId/cancel`
- `GET /api/audio/:fileId/inspect`, `/transcript`, `/analysis`; `POST /:fileId/query`, `/search`, `/summarize`, `/extract`, `/translate`, `/artifacts`
- `GET /api/audio/:fileId/media` — authorized, integrity-checked playback bytes (`nosniff`, `no-store`)
- `POST /api/audio/:fileId/memory-candidates` — decision/action-item candidates for **Step 15 Project Memory**, `system_derived` provenance, `candidate` status, zero authority until a human approves them

Owner scope is enforced server-side; the development principal is the fixed server default, and a client-supplied owner header is rejected. Same development-identity limitation as Step 19 applies (no authenticated sessions in this monorepo).

## UI (`apps/web`)

The **Audio intelligence** page: audio upload (reusing the Step 19 upload path), file list, in-browser player bound to the authorized media route, process/cancel with live job status, transcript with clickable timestamps (seek) and neutral speaker labels, transcript search, Q&A, summary styles, structured extraction, translation, and artifact save/download — each result visibly labeled `untrusted data` or `ai-generated`, with the mock provider's simulation status disclosed in the page subtitle.

### Known limits / future adapters

No real transcription provider (Whisper/Gemini audio-in or similar) is wired in; when one is added it must implement `AudioProvider`, pass the existing capability-honesty and evidence rules, and inherit every bound unchanged. No diarization-as-identity, no speaker verification, no streaming transcription, no live-call capture, no background job queue (jobs run in-process and die with the process), no production persistence. Long-audio strategies beyond bounded chunking are future work.
