# Document Intelligence (Step 23)

Bounded, auditable document understanding on top of the Step 19 file system.
`document-intelligence/core` parses documents genuinely and reasons about them
through a provider abstraction; `document-intelligence/mock` is the deterministic
offline provider.

## What is real and what is simulated

| Layer                                                                   | Status                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------- |
| Format detection                                                        | Real: magic bytes plus ZIP/OOXML structure        |
| Parsing (DOCX, XLSX, PPTX, PDF, CSV, Markdown, HTML, JSON, XML, TXT)    | Real, deterministic, bounded                      |
| Reasoning (summary, answer, entities, comparison, semantic search, OCR) | Deterministic mock provider (`simulated: true`)   |
| API surface                                                             | `providerIsSimulation` reports the above honestly |

No real document-reasoning model is wired into the API in this step. The mock
quotes only text genuinely present in the parsed structure, so its answers are
traceable, but they are not model-quality output.

## Formats

| Format     | Parser          | Notes                                                                                                |
| ---------- | --------------- | ---------------------------------------------------------------------------------------------------- |
| PDF        | `pdf.ts`        | `Tj`/`TJ` text operators, bounded streams. Scanned PDFs yield no text (OCR is a provider operation). |
| DOCX       | `docx.ts`       | Headings, paragraphs, list items, tables, core metadata.                                             |
| XLSX       | `xlsx.ts`       | Sheets, headers, cell text; formulas are recorded as text and **never evaluated**.                   |
| PPTX       | `pptx.ts`       | Slide titles, bullets and speaker notes (notes relationships resolved against the slide directory).  |
| CSV        | `structured.ts` | Delimiter detection from the header row, bounded rows and cells.                                     |
| Markdown   | `structured.ts` | Headings, lists, fenced code, tables, links.                                                         |
| HTML       | `structured.ts` | Headings, tables; `<script>` and `<style>` text is stripped entirely.                                |
| JSON / XML | `structured.ts` | Structure walk with bounded depth and node count.                                                    |
| TXT        | `structured.ts` | Paragraph split with a size ceiling.                                                                 |

Files whose magic bytes are not a supported document fail closed with
`DOCUMENT_UNSUPPORTED_FORMAT`.

## Trust model

- Extracted text, tables, cells and OCR output: `untrusted_data`.
- Summary, answer, entities, comparison, semantic matches: `ai_generated`.
- A quoted passage is only kept if it appears in the parsed text. When a provider
  claims evidence that does not exist, the answer is annotated as unconfirmed and
  confidence is forced to `low`.
- Secret-shaped content fails closed at parse time (`DOCUMENT_SECRET_REJECTED`).
- Document text is content, never instructions.

## Manager surface

`DocumentIntelligenceManager` (`document-intelligence/core/src/manager`):

| Method                                    | Purpose                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `inspect(fileId, principal)`              | Magic-byte format, byte size, capabilities, simulation flag             |
| `process(fileId, principal)`              | Parse into a bounded structure; returns a terminal job                  |
| `getJob` / `listJobs` / `cancelJob`       | Owner-scoped job reads and one-way cancellation                         |
| `getStructure`                            | Sections, elements, tables, counts                                      |
| `searchExact(fileId, query, principal)`   | Deterministic text search with element refs                             |
| `semanticSearch`                          | Provider-ranked matches, forged element ids dropped                     |
| `ask`                                     | Answer with verified evidence quotes                                    |
| `summarize(fileId, mode, principal)`      | `brief` / `bullets` / `executive`                                       |
| `extractEntities`                         | Closed entity-type union; unknown types recorded as `unknown`           |
| `compare(left, right, principal)`         | Structured side-by-side points                                          |
| `ocr`                                     | Provider OCR over the parsed structure                                  |
| `spreadsheetView` / `presentationView`    | Sheet and slide views; wrong formats fail `DOCUMENT_UNSUPPORTED_FORMAT` |
| `memoryCandidates`                        | Non-authoritative `system_derived` candidates for Step 15 memory        |
| `saveArtifact(fileId, principal, {kind})` | Derived export through the Step 19 file system                          |

## Artifacts

`document_structure_json`, `document_text_md`, `document_tables_csv`,
`document_summary_md`, `document_entities_json`, `document_search_json`,
`document_comparison_json`. Every export is regenerated from the current
structure, so an artifact can never carry stale content.

## Tools

Fourteen read-only Tool System tools: `document.inspect`, `document.process`,
`document.get_job`, `document.structure`, `document.search`,
`document.semantic_search`, `document.ask`, `document.summarize`,
`document.entities`, `document.compare`, `document.ocr`,
`document.spreadsheet_view`, `document.presentation_view`,
`document.memory_candidates`. Scopes are `document.read` and `document.reason`;
no tool declares a write scope.

## API

```
GET  /api/documents/capabilities
GET  /api/documents/jobs
GET  /api/documents/jobs/:jobId
POST /api/documents/jobs/:jobId/cancel
GET  /api/documents/:fileId/inspect
POST /api/documents/:fileId/process
GET  /api/documents/:fileId/structure
POST /api/documents/:fileId/search            { query }
POST /api/documents/:fileId/semantic-search   { query }
POST /api/documents/:fileId/ask               { question }
POST /api/documents/:fileId/summary           { mode }
GET  /api/documents/:fileId/entities
POST /api/documents/:fileId/compare           { otherFileId }
POST /api/documents/:fileId/ocr
GET  /api/documents/:fileId/spreadsheet
GET  /api/documents/:fileId/presentation
GET  /api/documents/:fileId/memory-candidates
POST /api/documents/:fileId/artifact          { kind, mode?, query?, otherFileId? }
```

Responses are safe normalized views: no provider internals, no storage paths, no
owner references. Error codes map to HTTP: 400 secret-shaped or invalid, 403
outside scope, 404 not found, 409 not processed or wrong format, 413 over limit,
502 provider failure.

## Web

`#/documents` (`apps/web/src/pages/DocumentsPage.tsx`): upload, document list,
detected format, process, sections and extracted text, exact search, ask with
evidence, summarize, entities, sheet and slide views, and artifact export. It
states plainly that parsing is real while reasoning is simulated.

## Known gaps

- Reasoning is the deterministic mock; no real document model is wired.
- Scanned/image-only PDFs produce no text; OCR needs a provider that can read images.
- Parsing is text-structural: it does not reconstruct page layout, and DOCX/PPTX
  images and charts are not extracted.
- Storage is the Step 19 in-memory development store; restarting the API clears uploads.
- No authenticated sessions exist in the monorepo; the development identity is fixed server-side.
