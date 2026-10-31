# Cross-Source Intelligence and Knowledge Synthesis (Step 25)

One question, answered from every source the owner is authorized to read, with each
statement tied to the passage it came from.

Package: `intelligence/core` (`@veltravia/intelligence-core`).

## What it does

| Capability              | Behaviour                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unified source registry | Uploaded documents (Step 19/23 parsers), connected-app resources (Step 24), project workspace files (Step 7) behind one adapter interface.                   |
| Cross-source search     | Ranking, deduplication by content fingerprint, filters (provider, type, project, workspace, date), cursor pagination.                                        |
| Evidence + citations    | Every excerpt carries source id, locator, revision, retrieval time and a verified flag. Excerpts are re-checked against the source before they can be cited. |
| Relationships           | `same_project`, `references`, `implements`, `supersedes`, `mentions`. Bounded graph, all edges `inferred: true` with an explanation.                         |
| Contradiction detection | `value_conflict`, `presence_conflict`, `superseded`. The detector never picks a winner.                                                                      |
| Synthesis               | Question → intent → search → content → evidence → relationships → contradictions → reasoning provider → claim validation → gaps → answer.                    |
| Comparison              | Two to five sources: participants, shared sections, conflicts, headings unique to one source.                                                                |
| Jobs                    | Owner-scoped async synthesis with cancel, retention and no cross-owner visibility.                                                                           |

## Honest limitations

- **Reasoning is not a language model.** Two deterministic providers ship:
  `mock_reasoning` (default, template-composed prose over real evidence) and
  `structural_extract` (pure extraction). Both disclose `simulated: true` in every
  answer and on the page. Selecting either is `INTELLIGENCE_REASONING_PROVIDER=structural`.
  Wiring a real model is a provider implementation, not an engine change.
- **Demo owner scoping.** The API derives the owner from `x-veltravia-owner-ref`
  (the convention every other owner-scoped step uses), falling back to
  `x-veltravia-owner`, then to `VELTRAVIA_DEFAULT_OWNER_REF` (`veltravia-dev-user`).
  A project created without an explicit `ownerRef` inherits the same header, so a
  caller can always find its own projects. A real deployment reads the owner from
  authentication and ignores the header.
- **Jobs are in-process.** A restart clears them; there is no durable queue.
- **Connected resources are only as live as their provider.** GitHub is live-capable
  when a token and repository allowlist are configured; Google Drive and Notion run the
  Step 24 simulation. Every answer reports which providers were searched and which were not.
- **Freshness is a window, not a guarantee.** Sources older than the window are marked
  `stale` and reported as a gap; the engine does not silently refresh them.

## Trust model

Retrieved content is `untrusted_data` everywhere. It is never an instruction, never a
permission grant, and never a fact until a claim cites a verified excerpt.

- Instruction-shaped text (`detectInjectionRisk`) is flagged on the source and returns
  as evidence only, never as a directive.
- A claim citing unknown evidence is downgraded to `unsupported` with no citations.
- Extracts that cannot be re-found in the source are withheld and counted as a
  `unsupported_claim` gap.
- Secret-shaped queries and questions are rejected before retrieval.
- Cross-owner reads return `INTELLIGENCE_SOURCE_NOT_FOUND`, indistinguishable from missing.

## API

```
GET  /api/intelligence/capabilities
GET  /api/intelligence/sources?q=&provider=&sourceType=&projectId=&limit=
GET  /api/intelligence/search?q=&provider=&sourceType=&projectId=&cursor=&limit=
POST /api/intelligence/analyze     { question, provider?, sourceType?, projectId?, sourceIds? }
POST /api/intelligence/compare     { sourceIds: [2..5] }
GET  /api/intelligence/relationships/:sourceId?depth=1|2
GET  /api/intelligence/evidence/:sourceId?limit=1..10
GET  /api/intelligence/jobs
POST /api/intelligence/jobs        { question }
GET  /api/intelligence/jobs/:jobId
GET  /api/intelligence/jobs/:jobId/result
POST /api/intelligence/jobs/:jobId/cancel
```

Status codes: `400` invalid request or secret-shaped input, `404` unknown source or job,
`409` job state conflict, `502` provider failure, `503` provider unavailable.

## Agent tools (read-only)

Registered in the Tool System with an explicit `intelligence.read` grant:

`intelligence.discover_sources`, `intelligence.search`, `intelligence.evidence`,
`intelligence.synthesize`, `intelligence.contradictions`, `intelligence.relationships`,
`intelligence.compare`, `intelligence.report`.

Registration itself grants nothing; every call resolves sources through the owner's own
adapters, so a tool cannot widen access.

## Web

`#/intelligence` (`IntelligencePage`): source list with provider, type, revision and
staleness; a question box; claim list with revealable cited passages; conflicts with both
sides; missing-information list; comparison of two to five selected sources; and an honest
"What this can and cannot do" panel.

## Tests

- `intelligence/core/src/registry.test.ts` - discovery, isolation, availability, injection flag.
- `intelligence/core/src/synthesis.test.ts` - intent, evidence, citation verification,
  contradictions, relationships, provider validation, forged-evidence downgrade.
- `intelligence/core/src/jobs.test.ts` - lifecycle, failure, cancel, ownership.
- `intelligence/core/src/tools.test.ts` - schema closure, grants, provenance, typed errors.
- `apps/api/src/tests/api-intelligence.test.ts` - routes, owner isolation, secret rejection.
- `apps/web/src/pages/IntelligencePage.test.tsx`, `apps/web/src/api/intelligence.test.ts`.
