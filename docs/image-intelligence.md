# Image Intelligence (Step 21)

First-class **image and screenshot understanding over Step 19 files**: describe, OCR, question answering, screenshot issue analysis, UI-structure extraction, chart reading, diagram extraction, structured field extraction, cross-image search, and derived artifacts. Image content is DATA: text rendered inside a screenshot that says "ignore previous instructions" is content being analyzed, never an authorized instruction. Nothing in this package executes tools, mutates projects, grants permission, or escalates trust.

This is a **development/CI foundation**. The API's wired provider is the deterministic mock simulation; it proves the complete pipeline (lifecycle, cancellation, trust tags, evidence rules, artifacts) but never represents real vision-model quality. A **real vision provider is not wired into the API in this step** and is explicitly not faked. Model/production quality is a roadmap item.

## Trust model (fixed)

- **OCR text is `untrusted_data`.** Rendered as text, searchable, usable as bounded reference — never as system/developer instructions, never as authorization.
- **Reasoning output is `ai_generated`.** Descriptions, answers, screenshot findings, chart readings, diagram structures, and extracted fields are interpretations, never facts about the system being analyzed.
- **Evidence references are manager-owned.** A provider that fabricates region IDs, node indexes, or other references has them silently dropped; only references minted by the manager survive into results.
- **Boxes, confidence, dimensions are honest.** Values outside their valid domain (e.g. a 0..1 box of [5,5,5,5]) are dropped to `null`, never clamped into plausibility.
- **UI structure is visual interpretation.** Extracted element trees carry an explicit caveat: they are what the provider thinks it sees, not the original DOM.
- **Injection stays data.** An image engineered to carry prompt injection is OCR'd and analyzed as content. The manager surface exposes no execute/approve/confirm methods; the audit trail never carries image bytes or OCR text.

## Domain (`image-intelligence/core`)

- **Security (`security/`)** — magic-byte format detection (never declared MIME), per-container parsing (PNG IHDR color info, GIF/WebP/PNG animation info with honest nulls for non-animated containers), SVG script detection (script-bearing SVG is refused), and the dimension ceiling.
- **`ImageProvider` + registry (`provider/`)** — the single provider seam with a closed capability union (image_understanding, ocr, text_in_image_search, image_comparison, screenshot_analysis, ui_structure_extraction, chart_understanding, diagram_extraction, document_image_understanding) and a closed operation union (describe, ocr, query, screenshot, ui_structure, chart, diagram, extract, compare). The manager refuses operations no registered provider can genuinely perform (`IMAGE_CAPABILITY_UNSUPPORTED`).
- **`ImageIntelligenceManager`** — validated job lifecycle (`received → validating → describing → extracting → analyzing → completed`, with `failed/cancelled/expired` terminal branches), owner-scoped jobs, per-provider-call cancellation probes (one-way, terminal), hard ceilings, scrubbed audit events (identifiers and counts, never image content), and the operations `inspect`, `process`, `analysis`, `query`, `screenshot`, `uiStructure`, `chart`, `diagram`, `extract`, `compare`, `searchImage`, `searchImages`, `saveArtifact`, `mediaBytes`.
- **Reasoning (`reasoning/`)** — a strict fail-closed JSON parser for provider output: bare JSON objects only (no markdown fences, no preamble), mandatory summary/answer fields, bounded arrays with `OTHER-DATA-OMITTED` markers when truncated, forged reference neutralization, unknown kinds mapped to `other`/`unknown`, extraction uncertainty flags.
- **Artifacts** — description/OCR/analysis/screenshot/comparison/chart/diagram artifacts persist through the **existing Step 19 file system** with provenance to the parent image file. They ride the same checksum, expiry, opaque download and integrity rules.
- **Tools** — Tool System definitions (`image.inspect`, `image.analyze`, `image.ocr`, `image.describe`, `image.ask`, `image.screenshot`, `image.ui_structure`, `image.chart`, `image.diagram`, `image.extract`, `image.compare`, `image.search`, `image.artifact`, `image.capabilities`) over permissions `image.read`/`image.reason`/`image.process`. Registration grants NOTHING; the API grants only the read-only `inspect`, `search`, `describe`, and `ocr` tools.

Limits (defaults / ceilings, `limits/index.ts`): 10 MiB file (50 MiB ceiling), 12,000 px dimension (30,000 ceiling), 64 frames (512 ceiling), 60s processing (300s ceiling), 4 concurrent jobs (16 ceiling), bounded context/search/OCR/compare ceilings, 24h job TTL (168h ceiling). No caller-provided option may exceed a ceiling.

## Mock (`image-intelligence/mock`)

`createMockImageProvider` is a deterministic, offline, scripted simulation: checksum-keyed scripts, bounded default outputs for unknown images, a prompt-injection fixture (`INJECTION_IMAGE_SCRIPT`), and failure injection (`provider_error`, `malformed`, cancellation) plus configurable latency for timeout/cancellation testing. It simulates every capability honestly and claims no real model quality.

## API (`apps/api`)

`createImageIntelligenceService` wires the manager over the Step 19 file manager. `IMAGE_MOCK_LATENCY_MS` slows the simulated provider for live cancellation QA. Routes (`apps/api/src/routes/image.ts`), all returning safe views only:

- `GET /api/image/capabilities` — provider surface, simulation status, operations, limits
- `POST /api/image/:fileId/process` (202 + early job snapshot), `GET /api/image/jobs`, `GET /api/image/jobs/:jobId`, `POST /api/image/jobs/:jobId/cancel`
- `GET /api/image/:fileId/inspect`, `/analysis`; `POST /:fileId/query`, `/screenshot`, `/ui-structure`, `/chart`, `/diagram`, `/extract`, `/compare`, `/artifact`; `GET /:fileId/search?q=`, `POST /api/image/search`
- `GET /api/image/:fileId/media` — authorized, integrity-checked display bytes (`nosniff`, `no-store`)

Owner scope is enforced server-side; the development principal is the fixed server default, and a client-supplied owner header is rejected. Same development-identity limitation as Steps 19–20 applies (no authenticated sessions in this monorepo).

## UI (`apps/web`)

The **Image intelligence** page: image upload (reusing the Step 19 upload path), file list, preview bound to the authorized media route, process/cancel with live job status, AI-generated description with observed-vs-inferred separation, OCR labeled untrusted data, ask-a-question, in-image and cross-image search, screenshot analysis, UI-structure extraction, chart reading, diagram extraction, field extraction, side-by-side comparison, and artifact save — each result visibly labeled `untrusted data` or `ai-generated`, with the mock provider's simulation status disclosed in the page subtitle.

### Known limits / future adapters

No real vision provider (Gemini image-in or similar) is wired in; when one is added it must implement `ImageProvider`, pass the existing capability-honesty and evidence rules, and inherit every bound unchanged. No image generation or editing, no face recognition or identity claims, no EXIF/location extraction, no live screen capture, no background job queue (jobs run in-process and die with the process), no production persistence. Multi-image pipelines beyond the bounded `compare` pair are future work.
