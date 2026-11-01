# Veltravia AI

Veltravia AI is an advanced AI software-development platform. Its long-term goal is a system that can build web and mobile applications, backend systems and APIs, generate and modify code, test and debug projects, connect to multiple AI providers and external services, maintain project memory, and improve itself through a controlled, reviewed self-development process.

**Current development stage: Step 13 — App Generation Engine.**
Steps 1–18 are complete (foundation, AI Core, Gemini adapter, connector framework, tool system, agent layer, project engine, sandbox, coding agent, the first real connector, the web UI through live project context in the AI workspace, the integration layer, the app generation engine, the testing & debugging agent, project memory, codebase intelligence, preview & app runtime, and version control): the monorepo foundation, the provider-neutral **AI Core** (`ai/core`) with its mock provider, the **Gemini adapter** (`ai/providers/gemini`, the only code importing the Gemini SDK), the **connector framework** (`connectors/core` + `connectors/mock`), and the **tool system** (`tools/core` + `tools/mock`: schema-validated tool definitions, a permission-gated manager where registration grants nothing, single-use input-bound human confirmations, and a controlled invocation pipeline ending at the ConnectorManager). Step 6 adds the **AI agent layer**: `agent/core` (`@veltravia/agent-core`) — provider-neutral agents that reason about a task, request tools THROUGH the Tool System (never around it), process normalized results, pause for human confirmations, and complete within hard limits (no unlimited loops, no unbounded history); a controlled state machine with terminal statuses, validated decisions (raw model output is never acted on), cancellation, scrubbed audit events, and trust-tagged context that treats tool results as UNTRUSTED DATA — plus `agent/mock` (`@veltravia/agent-mock`), deterministic offline scripted agents, and safe run/confirmation/cancellation API endpoints (`/api/agents…`). The agent is a GENERAL ORCHESTRATOR, not a coding agent: it cannot execute code, touch files, approve its own confirmations, or change its limits (see [docs/architecture.md](docs/architecture.md) and [docs/agents.md](docs/agents.md)). Step 7 adds the **Project & Workspace Engine**: `project-engine/core` (`@veltravia/project-core`) — projects with validated lifecycle transitions (soft delete is terminal), workspaces that always belong to a valid project, and virtual file trees with hardened path security (traversal, absolute, Windows, null-byte, control-character rejection), duplicate/parent/type rules, optimistic revision protection on every mutation, credential-free integration references, deterministic secret-free snapshots, and structured project context/configuration. `project-engine/mock` (`@veltravia/project-mock`) provides deterministic in-memory repositories behind the same interfaces a future database adapter will implement. The engine is PURE STATE MANAGEMENT: no host filesystem access, no execution, no GitHub, no concrete databases. File contents, context, configuration, and metadata are PROJECT DATA — never instructions. A strict API surface (`/api/projects…`, `/api/workspaces…`) exposes it with every rule enforced server-side (see [docs/project-engine.md](docs/project-engine.md)). Step 8 adds the **Sandbox Engine**: `security/sandbox` (`@veltravia/sandbox-core`) — a security-first, provider-neutral execution abstraction. Untrusted code NEVER runs in the API host process: the SandboxManager is a pure orchestrator, and the only executor is the `SandboxRuntime` adapter behind the isolation boundary. Sandboxes have a validated lifecycle (destroyed is terminal; TTL expiry freezes execution), an allowlist-first command policy with a hard denylist and **no shells** (structured `command + arguments` only), environment isolation (the host environment is never inherited — source-scan enforced), a disabled-by-default network policy, complete resource limits with hard ceilings, one-way cancellation with race protection, and bounded, secret-scrubbed output. Sandbox tools ride the Step 5 Tool System (`sandbox.execute` is high risk → forced human confirmation); there is no unrestricted execution endpoint. `security/sandbox-mock` (`@veltravia/sandbox-mock`) is the deterministic offline mock runtime — it executes NO host code and claims NO OS-level isolation; a production container/microVM runtime implements the same interface later (see [docs/sandbox.md](docs/sandbox.md)). Step 9 adds the **Coding Agent**: `coding-agent/core` (`@veltravia/coding-agent-core`) — the file-and-validation specialization of the agent loop. Coding runs are bounded and state-machine-driven: a validated plan that a HUMAN approves before any mutation, decisions that are validated (the model cannot invent tools), file mutations and validations that flow ONLY through the Tool System (deleting a file and sandbox execution are high risk → forced human confirmations), revision discipline (must read or create before update/delete; stale revisions fail typed; the run's sandbox id is never taken from decisions), file content treated as UNTRUSTED DATA (prompt injection gains no authority), secret rejection on every coding input surface, server-side limits with hard ceilings, one-way cancellation, and scrubbed audit. `coding-agent/mock` (`@veltravia/coding-agent-mock`) provides deterministic offline scripted decision sources and a full fixture environment; the API exposes safe run/inspect/cancel/confirmation endpoints (`/api/coding/runs…`) that return only normalized run views — no file contents, no secrets, no chain-of-thought (see [docs/coding-agent.md](docs/coding-agent.md)). Step 10 adds the **first real connector and `invoke_tool`**: `connectors/github` (`@veltravia/connector-github`) — scoped GitHub source control (an explicit `owner/repository@branch` list enforced on every operation), hardened path/branch/sha validation, revision-protected writes, typed scrubbed errors, and an HTTPS-only production transport whose token is read per request and never retained; plus a deterministic offline fake transport so the whole suite runs keyless. The coding agent's optional `invoke_tool` action is allowlist-gated (trusted server-side config only), re-passes the full Tool System pipeline, forces human confirmation for high-risk tools, and replays tool results as UNTRUSTED DATA (see [docs/connectors.md](docs/connectors.md) and [docs/security.md](docs/security.md)). Step 11A adds the **web UI foundation**: a token-based design system (typography, spacing, radius, shadows, borders, restrained motion), a reusable accessible component library (buttons, fields, switches, badges, cards, tooltips, dialogs, menus, tabs, toasts, empty/error states, and more), a light/dark/system theme architecture driven by `data-theme` + CSS custom properties, and a responsive application shell (collapsible sidebar, top bar with account menu, mobile drawer navigation) routing Dashboard / Projects / Settings to clearly-marked placeholder pages — no fabricated functionality (see [docs/ui.md](docs/ui.md)). Step 11B adds the **first real web feature surface**: a typed fetch client (`apps/web/src/api/`) that validates every response and maps it to a safe view model (engine-internal fields never reach React state), and the **Dashboard / Projects / Project detail** pages — project creation (server-assigned ownership), revision-safe editing (409 conflicts are surfaced, never silently overwritten), confirmation-gated archive/restore, status filtering, workspace overview + creation, and honest loading/empty/error states throughout, all backed by the real Project Engine API. Step 11C-1 adds the **AI workspace shell**: a per-project workspace page (`#/projects/<id>/workspace`) with a project context panel, AI conversation surface and composer, and agent/tool activity panels — a responsive three-region layout (side panels become accessible drawers on mobile) with an explicit trust visual language for message origins. It is a visual shell only: nothing calls an AI, tool, sandbox, or connector API, submitted text stays local, the file tree is a labeled illustration, and no functionality is fabricated (see [docs/ui.md](docs/ui.md)). Step 11C-2 wires that workspace to the EXISTING Agent API: submitting the composer creates a real agent run (`POST /api/agents/run` with `{ agentId, task, projectId }`), run statuses map to explicit UI phases, non-terminal states are followed with bounded polling, cancellation flows through the real cancel endpoint and is claimed only on server confirmation, and a completed run's `finalOutput` renders as the assistant message — never a fabricated response, with honest failed/cancelled/limit states and new-run retry. One active run per conversation, generation-guarded against stale responses; the browser remains a pure presentation client (no provider SDKs, endpoints, credentials, or environment reads in web source — test-enforced) (see [docs/ui.md](docs/ui.md) and [docs/security.md](docs/security.md)). Step 11C-3 adds **human confirmations and tool activity to the workspace**: a paused run's pending confirmation becomes an approve/reject card that renders only server-reported metadata (tool id, risk level, state — never the requested input), the decision travels to the real confirmation endpoint, and the Tool System — never the browser — validates expiry, input binding, and permissions before executing or skipping the tool; the activity panel lists recorded tool invocations and the pending confirmation in backend order with tool output treated as bounded UNTRUSTED DATA, every run phase maps to one honest entry, an expired confirmation is terminal in the UI, at most one decision is in flight per run, and a failed delivery keeps the run at its last server-confirmed state with an honest note and a single resync (see [docs/ui.md](docs/ui.md) and [docs/security.md](docs/security.md))). Step 11C-4 gives the workspace **real project context**: run requests carry `projectId` + the selected `workspaceId`, the association is validated server-side against the Project Engine (unknown ids → 404, a foreign workspace → 400, no unchecked association), and the API derives a bounded safe context — project/workspace metadata plus a STRUCTURE-ONLY file tree (paths + types, honest truncation flags, never file contents) — delivered as an explicit `project_context` UNTRUSTED DATA block that is never concatenated into the trusted system prompt. The context panel becomes live (real project metadata, a workspace picker, and the workspace's actual read-only file tree), and the web source never calls file-content endpoints nor mutates files (test-enforced) (see [docs/ui.md](docs/ui.md) and [docs/security.md](docs/security.md)). Step 11C-5 closes the workspace phase with a polish + regression-hardening pass: broken font-weight token references fixed, stale pre-11C-3 copy removed, the conversation becomes a polite `role="log"` live region (announced, never focus-stealing), client-side create failures leave an honest unique system note, the run-status strip aligns with the conversation column, long paths/tool output wrap instead of overflowing, the workspace header becomes a proper `<h2>`, and dead CSS is removed — presentation-only, with no new capability and no trust-boundary change. Step 12 adds the **integration layer**: `integrations/core` (`@veltravia/integration-core`) — declarative integration manifests with strict registry validation, an owner-boundary connection manager (explicit scope grants, validated lifecycle, terminal disconnect), a secret boundary that resolves credentials inside the runtime only (never stored, logged, or returned), and a 13-step fail-closed execution pipeline whose ONLY caller is the Tool System's `connectorExecutor` seam (high-risk operations must arrive Tool-System-confirmed — this layer is a bypass-proof gate, never a second approval path), plus typed scrubbed errors and bounded audit events. `connectors/integration-mocks` provides deterministic offline Storage/Database integrations, the GitHub connector is now an explicit hand-written integration definition, and a catalog + connection API (`/api/integrations…`) plus the web Integrations page (`#/integrations`) expose safe views only — no credential material anywhere (see [docs/integrations.md](docs/integrations.md) and [docs/security.md](docs/security.md) §5i). Step 13 adds the **App Generation Engine**: `generation/core` (`@veltravia/generation-core`) — the idea-to-app pipeline. A natural-language idea is validated and planned by a provider-neutral `GenerationPlanner` (deterministic offline mock today; every planner output is re-validated with strict bounded schemas — malformed, oversized, or secret-shaped input fails closed), the bounded plan view (paths + byte sizes, dependencies, commands, risk summary) is approved by a HUMAN before anything is created, files and directories flow only through the Tool System (explicit minimal server-side grants; nested parents are created idempotently), validation and test commands run through the Step 8 sandbox (the forced high-risk `sandbox.execute` confirmation pauses the run for a human, and a resumed run re-submits the STORED input), a bounded repair loop handles honest validation/test failures, and hard limits with ceilings plus one-way cancellation terminate every run with a typed outcome. `generation/mock` ships the deterministic planner, a declining repair source, and the server-side templates; the API exposes safe normalized run/plan/result views (`/api/app-generations…`) — never file content, host paths, or chain-of-thought (see [docs/generation.md](docs/generation.md) and [docs/security.md](docs/security.md) §5j). Step 14 adds the **Testing & Debugging Agent**: `testing/core` (`@veltravia/testing-core`) — structured test runs over REAL projects in the Project Engine. The agent detects a project's test surface structurally (manifest parsed, never executed; only allowlisted bare executables become commands, shell-shaped scripts rejected), builds a bounded `TestPlan` a HUMAN approves, and executes validation/test/build commands ONLY through the Tool System + Secure Sandbox with forced confirmations. Failures are classified deterministically into a closed vocabulary, diagnosed with a provider-neutral `DebugAgent` under an explicit FACT/INFERENCE/RECOMMENDATION discipline (all outputs re-validated; file contents are UNTRUSTED DATA), and repaired only through the existing Coding Agent behind its own plan approval — within a hard repair limit, with revision conflicts failing typed instead of retried blindly. Hard limits with ceilings, one-way cancellation, scrubbed audit, and safe normalized run views (`/api/testing/runs…`) that never expose file contents, secrets, host paths, or chain-of-thought; the deterministic offline mock debug agent ships today, and an AI-routed one is a one-argument swap (see [docs/testing.md](docs/testing.md) and [docs/security.md](docs/security.md) §5k). Step 15 adds **project memory**: `memory/core` (`@veltravia/memory-core`) — a durable, human-owned per-project fact store with validated lifecycle (active/archived/candidate/rejected), optimistic revisions, secret rejection at every write surface, hard capacity limits, provenance on every record, and a Memory Context Builder that wraps approved facts in a labeled UNTRUSTED-reference-data block before they reach any agent run; AI-extracted candidates from COMPLETED generation/testing runs are NON-AUTHORITATIVE and enter context only after an explicit human approve, memory is server-derived only (the browser never supplies it) and an enhancement, never a gate. `memory/mock` (`@veltravia/memory-mock`) provides the deterministic in-memory repository; the API exposes `/api/projects/:id/memories…` (CRUD, search, archive/restore/verify/stale, candidate review, stats, extraction) with safe normalized views only (see [docs/memory.md](docs/memory.md) and [docs/security.md](docs/security.md) §5l). Step 16 adds **Codebase Intelligence**: `codebase/core` (`@veltravia/codebase-core`) — a structural understanding of a workspace's source, built on the same trust rules as every other subsystem. A build reads source ONLY through the `CodebaseSourceProvider` port (a read of already-authorized project files) and keeps only metadata: languages and frameworks (evidence-backed, confidence-scored), symbols, import/reference/caller/callee relationships, entry points, routes, and components — never file contents or values; secret-shaped files are flagged by path with the values never read into the index, and evidence text is scrubbed. Hard limits with ceilings bound everything (indexed files, symbols, relationships, per-file bytes, build duration, search results, trace depth/nodes) and truncated responses say so honestly. Eight read-only tools (`codebase.search`, `find_symbol`, `find_references`, `find_callers`, `find_callees`, `trace_feature`, `get_summary`, `get_file_symbols`) ride the Step 5 Tool System (permission `codebase.read`) — agents have no other path to the index. Completed indexes can contribute bounded structural facts to project memory as NON-AUTHORITATIVE candidates under the Step 15 human-approval rules. `codebase/mock` (`@veltravia/codebase-mock`) provides the deterministic in-memory repositories; the API exposes `/api/projects/:id/codebase…` (index, build, search, trace, summary, per-file symbols, memory-candidate extraction) with safe normalized views only, and the web workspace gains a Codebase analysis panel (desktop side panel + mobile drawer) that shows index status, stats, search, feature traces, and flagged-secret counts — never source content (see [docs/codebase.md](docs/codebase.md) and [docs/security.md](docs/security.md) §5m). Step 17 adds the **preview / app runtime**: `runtime/core` (`@veltravia/runtime-core`) — a validated evidence-based plan → build → start → health-check → serve lifecycle for generated apps. Plans are DETECTED from workspace evidence (manifest scripts, frameworks, present files, codebase index) and validated server-side with structured allowlisted commands, bounded limits with hard ceilings, and secret-shaped environment rejection; the browser never supplies commands, ports, limits, or environment values. Runtimes are revision-bound to their workspace (staleness is reported honestly, start fails typed on revision mismatch, restart rebuilds at the LATEST revision), live within validated state-machine transitions, one-way cancellation, idle + lifetime expiry through a sweep, hard ceilings, structured failure reports, and bounded scrubbed logs. The RuntimeExecutor seam is the ONLY execution path — the API server is NEVER the runtime — and `runtime/mock` (`@veltravia/runtime-mock`) is the deterministic SIMULATED executor (full failure matrix, honestly labeled everywhere, NO OS-level isolation claims); a production container/microVM executor implements the same interface later. The preview page serves only through the platform-controlled `/preview/:runtimeId` URL with sandboxing headers, and the Project Detail page gains a Preview panel (create/start/stop/restart, honest status/plan/failure/logs, bounded slow-follow). Runtime facts flow into project memory as NON-AUTHORITATIVE candidates under the Step 15 human-approval rules (see [docs/runtimes.md](docs/runtimes.md) and [docs/security.md](docs/security.md) §5n). Step 18 adds **version control**: `version-control/core` (`@veltravia/version-core`) — an append-only revision history for every workspace. Each revision is a content-addressed, integrity-verified snapshot of the whole tree (corruption fails closed, never silently degrades), with bounded line diffs, named advisory checkpoints (deleting a marker never touches a revision or file), honest retention with hard ceilings and protected-revision counting, and TWO-PHASE rollback: a restore is a REQUEST guarded by `expectedCurrentRevision` optimistic concurrency that PAUSES for a human confirmation, executes step by step through the normal file-tree operations, and APPENDS a new `rollback`-source revision — history is never rewritten. Rollback runs at critical risk through the Tool System (forced confirmation, no bypass path); every capture/restore/checkpoint/retention event lands in the scrubbed audit trail. Coding, generation, and testing runs are now bracketed by BEST-EFFORT route-level captures (a capture failure never fails the run). `version-control/mock` (`@veltravia/version-mock`) is the deterministic in-memory store; a production store implements the same `VersionStore` port later. The API exposes timeline/diff/compare/checkpoint/rollback endpoints as safe normalized views, and the Project Detail page gains a Version History panel (capture, diff dialog, checkpoints, restore with an explicit confirmation dialog that states nothing is lost) (see [docs/version-control.md](docs/version-control.md) and [docs/security.md](docs/security.md) §5o).

## Technology stack

| Concern  | Choice                                                | Why                                                                                                  |
| -------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Language | TypeScript (strict)                                   | One language across web, API, packages, and future AI/connector code; catches errors at compile time |
| Runtime  | Node.js 20 (ESM)                                      | Modern LTS; native ESM; first-class support in serverless and container hosts                        |
| Monorepo | npm workspaces                                        | No extra tooling to install; workspaces + a single lockfile keep CI simple and reproducible          |
| Web app  | Vite 6 + React 19                                     | Fast dev server and production bundler; largest ecosystem for the future UI-heavy platform           |
| API      | Fastify 5                                             | Fast, TypeScript-first, schema-based validation ready for when connectors/APIs grow                  |
| Testing  | Vitest 3                                              | Fast, ESM-native, Jest-compatible API; runs TS sources directly across workspaces                    |
| Linting  | ESLint 9 (flat config) + typescript-eslint + Prettier | Standard, minimal setup; uniform style and error rules across every package                          |
| Builds   | `tsc` (packages/API) + Vite (web)                     | Deterministic compiler output for server code, optimized bundling for the browser                    |

Dependencies are intentionally minimal. Nothing is added "for later" — each later step adds what it needs.

## Repository layout

```
veltravia-ai/
├── apps/
│   ├── web/        # Vite + React web application
│   └── api/        # Fastify backend API service
├── packages/
│   ├── shared/     # Framework-agnostic utilities
│   ├── config/     # Environment variable loading/validation
│   └── types/      # Shared TypeScript domain types
├── ai/
│   ├── core/       # AI Core: types, provider interface, registry, router, errors, config
│   └── providers/  # mock/ + gemini/ implemented; other adapters arrive later
├── connectors/    # Connector framework (Step 4)
│   ├── core/       # Provider-neutral connector interface, permissions, registry, manager
│   ├── mock/       # Deterministic offline proof connector
│   └── providers/  # Future vendor connectors (GitHub, databases, storage, payments, …)
├── tools/         # Tool & function system (Step 5)
│   ├── core/       # Tool definitions, validation, registry, manager, executor, audit
│   └── mock/       # Deterministic offline proof tools
├── agent/         # AI agent layer (Step 6)
├── project-engine/ # Project & Workspace Engine (Step 7)
│   ├── core/       # Models, path security, repositories, managers, snapshots
│   └── mock/       # Deterministic in-memory repositories
├── security/       # Sandbox Engine (Step 8)
│   ├── sandbox/    # Sandbox core: lifecycle, command policy, isolation rules, manager
│   └── sandbox-mock/ # Deterministic offline mock runtime (dev/CI only, no OS isolation)
├── tests/          # Cross-workspace integration tests
├── docs/           # Architecture and security documentation
├── scripts/        # Developer helper scripts
└── .github/
    └── workflows/  # CI pipelines
```

See [docs/architecture.md](docs/architecture.md) for the purpose of every directory and how the system is expected to evolve.

## Local development

Prerequisites: Node.js 20+ and npm 10+.

```bash
# 1. Install dependencies (all workspaces)
npm install

# 2. Configure environment (optional for Step 1 — nothing requires secrets yet)
cp .env.example .env

# 3. Run everything CI runs: lint -> test -> build
npm run check

# Or run the parts individually
npm run lint      # ESLint + Prettier check
npm test          # Vitest (unit + integration)
npm run build     # Type-check and build every workspace in dependency order

# Dev servers
npm run dev:api   # http://localhost:3000/health
npm run dev:web   # http://localhost:5173
```

## The AI Core and the provider system

- **Provider-neutral by design.** Veltravia AI owns its internal interface (`AIRequest`/`AIResponse`); vendor formats exist only inside future adapter packages. Adding a provider = one adapter + registry entries, nothing else changes.
- **Capability system.** Models declare capabilities (text-generation, vision, embeddings, …); the router only picks models that declare everything a request needs.
- **Typed errors everywhere.** One normalized error hierarchy with stable codes (`AI_MODEL_NOT_FOUND`, …) — vendor errors never reach application code.
- **Mock provider.** Deterministic, offline, keyless — the whole core is testable without the Internet.
- **No secrets in the core.** The core reads only routing/limit config from the environment; real API keys are bound inside adapters.
- **Gemini adapter (Step 3).** `ai/providers/gemini` implements `AIProvider` on top of Google's current official interface — the Interactions API (`interactions.create`, GA June 2026) — via the official `@google/genai` SDK. It maps requests/responses, normalizes every error (with the API key scrubbed from all messages), and is the ONLY code in the platform that imports the Gemini SDK. The API registers it only when `GEMINI_API_KEY` is present; without a key, the offline mock serves everything.

### Optional live Gemini test

The test suite never contacts the real Gemini API — `tests/live/gemini.live.test.ts` skips unless BOTH `RUN_GEMINI_INTEGRATION_TESTS=true` AND `GEMINI_API_KEY` are set locally:

```bash
RUN_GEMINI_INTEGRATION_TESTS=true GEMINI_API_KEY=... npx vitest run tests/live/gemini.live.test.ts
```

CI never sets these, so CI stays offline and keyless.

## Testing

Tests use **Vitest**:

- Unit tests live next to the code they test (`packages/*/src/*.test.ts`, `ai/**/src/**/*.test.ts`, `apps/*/src/**/*.test.ts`) — covering the registry, router, validation, error system, config, and the mock provider.
- Cross-workspace integration tests live in [`tests/`](tests/) — the API health test, the `/api/ai/generate` mock tests, the Gemini router/API integration tests, the connector API tests, and the tool API tests (`apps/api/src/tests/`) exercise the real Fastify app and the real registries/routers, including error mapping and secret-leak checks (all with fake/ offline clients — no network, no key). Tool-core tests additionally prove the full invocation pipeline: unknown tools, invalid input, denied permissions, confirmation required/approved/rejected/expired, deterministic execution, output validation, connector authorization without bypass, and that secret-like values never surface in errors or audit events.
- Vitest resolves workspace packages directly from their TypeScript sources, so tests never require a prior build step.

## GitHub Actions / CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every **push** and every **pull request**:

1. Install dependencies with `npm ci` (npm cache enabled via `actions/setup-node`)
2. `npm run lint` — ESLint + Prettier check
3. `npm test` — the full Vitest suite
4. `npm run build` — type-check + production build of every workspace

Any failing step fails the workflow. No API keys or credentials exist in the repository; CI requires none today.

## Security rules

The full policy lives in [docs/security.md](docs/security.md). The non-negotiables:

- **Secrets are never committed to Git.** `.env` is git-ignored; only `.env.example` (placeholders) is committed.
- Production secrets are stored in a proper secret manager (GitHub Actions secrets today; a dedicated vault later), never in code or config files.
- AI-generated code will eventually execute **only inside an isolated sandbox** — never with unrestricted access to the host machine.
- The future self-development system requires controlled testing and explicit human approval before any production change.
- Connector credentials are referenced, never stored in the connector core, never returned via API responses, and never logged (scrubbed from every error and audit event).
- Tools are gated: registration grants nothing, inputs are validated, permissions are explicit, risky actions require human confirmation, and connector-backed tools can never bypass the ConnectorManager.
- Integrations are manifests + owner-scoped connections: scope grants are explicit, the runtime fails closed on every rule, credentials are resolved inside the boundary only, and execution happens exclusively through the Tool System's connectorExecutor seam.

## Architecture overview

Veltravia AI will evolve step by step (details in [docs/architecture.md](docs/architecture.md)):

1. **Foundation** _(done)_ — monorepo, tooling, CI, security documentation
2. **Core AI** _(done)_ — provider-agnostic AI Core (`ai/core`), mock provider, `/api/ai/generate`
3. **Gemini provider** _(done)_ — first real adapter (`ai/providers/gemini`), Interactions API
4. **Connector architecture** _(done)_ — provider-neutral connector framework (`connectors/core`, `connectors/mock`), credential isolation, read-only API
5. **Tool/Function System** _(done)_ — tool definitions, schema validation, permission gating, human confirmation, controlled invocation (`tools/core`, `tools/mock`), read-only API
6. **AI agent layer** _(done)_ — controlled agent orchestration (`agent/core`, `agent/mock`): bounded loops, validated decisions, tool requests through the Tool System, human confirmations, cancellation
7. **Project & Workspace Engine** _(done)_ — projects, workspaces, virtual file trees, path security, revision protection, snapshots, integration references, strict API (`project-engine/core`, `project-engine/mock`)
8. **Sandbox Engine** _(done)_ — secure code-execution abstraction (`security/sandbox`, `security/sandbox-mock`): lifecycle, allowlist command policy, environment/network isolation, resource ceilings, cancellation, scrubbed output, sandbox tools via the Tool System
9. **Real connectors** _(done)_ — first real connector: scoped GitHub source control (`connectors/github`), executed only through the Tool System (Step 10)
10. **Web UI** _(done)_ — dashboard, projects, and the live AI workspace: runs, human confirmations, tool activity, real project context (Steps 11A–11C-5)
11. **Integrations & connections** _(done)_ — the user-facing integration layer: manifest catalog, owner-scoped connections with explicit scope grants, Tool-System-gated runtime (`integrations/core`, `connectors/integration-mocks`, Step 12)
12. **Self-development** — propose → test → review → deploy pipeline, behind approval gates (`security/`)

### File Intelligence and Artifacts (Step 19)

The [File Intelligence and Artifacts foundation](docs/file-intelligence.md) adds bounded upload/validation, safe extraction, file and artifact lineage, checksum-validated downloads, Tool System access, and a Files & Artifacts UI. Storage is an explicitly **in-memory development mock**; this is not production durability or authenticated multi-tenant hosting. Video/image intelligence remains out of scope; audio understanding arrived in Step 20 below.

### Audio Intelligence (Step 20)

The [Audio Intelligence foundation](docs/audio-intelligence.md) adds first-class audio understanding over Step 19 files: transcribe → search/ask/summarize/extract/translate → derived artifacts, with a fixed trust model (transcripts are untrusted data; reasoning output is ai-generated and never an action), bounded chunked jobs with cancellation, owner-scoped access, Tool System tools with explicit read-only grants, memory candidates under the Step 15 human-approval model, and an Audio intelligence page in the web app. The wired provider is the deterministic mock simulation - honestly disclosed in the UI and API; a real transcription provider is future work and is not faked.

The [Video Intelligence foundation](docs/video-intelligence.md) extends understanding to video over Step 19 files: container metadata from parsed MP4/WebM boxes (never declared filenames), bounded cancelable jobs, frames, scenes, transcription, OCR, temporal questions, timelines, summaries, field extraction, translation, comparison, search and derived artifacts. Spoken words and visible text are untrusted data; reasoning output is ai-generated interpretation and never an action. The wired provider is the deterministic mock simulation, honestly disclosed in the UI and API.

The [Document Intelligence foundation](docs/documents.md) adds document understanding over Step 19 files: magic-byte format detection with genuine, bounded parsing for DOCX, XLSX (formulas recorded, never evaluated), PPTX (including speaker notes), PDF, CSV, Markdown, HTML (script/style stripped), JSON, XML and TXT. Extracted text and tables are untrusted data; summaries, answers, entities, comparisons and semantic matches are ai-generated. Evidence quotes are verified against the parsed text, forged quotes are dropped and the answer is marked unconfirmed. Documents are served through owner-scoped jobs, 14 read-only tools, a full `/api/documents` surface and the `#/documents` page. The wired reasoning provider is the deterministic mock simulation, disclosed in the API and UI; parsing is real.

The [Connected Apps foundation](docs/connected-apps.md) adds read-only intelligence over apps the owner explicitly connects. Connections are owner-scoped, grant only the scopes the owner chooses, and every result carries provenance (provider, account, resource, revision, retrieval time). All connected content is untrusted data and never authorization. GitHub is a real connector with a repository allowlist, live when a token and allowlist are configured; Google Drive and Notion run deterministic simulations, and each response states which mode is active. Ten read-only tools, an `/api/connections` surface and the `#/connections` page expose listing, search, metadata, bounded content and structured analysis that reuses the Step 23 document parsers.

The [Cross-Source Intelligence foundation](docs/intelligence.md) answers a question across every source the owner may read - uploaded documents, connected-app resources and project workspace files - through one owner-scoped registry. Search ranks, deduplicates and paginates with provenance; evidence carries a locator, revision and retrieval time and is re-verified against the source before a claim can cite it; relationships and contradictions are derived by bounded deterministic rules that explain themselves. Conflicts are reported with both sides and never silently resolved, and explicit supersessions are the only case given a resolution. Reasoning is a replaceable provider with an honest disclosure: `mock_reasoning` (default) and `structural_extract` both report `simulated: true`, so nothing claims to be model-written when it is not. The engine rejects secret-shaped questions, flags instruction-shaped content without obeying it, and downgrades any claim citing evidence it cannot verify. Eight read-only tools, an `/api/intelligence` surface and the `#/intelligence` page expose search, synthesis, contradictions, relationships, comparison and a cross-source report.

The [Image Intelligence foundation](docs/image-intelligence.md) adds first-class image and screenshot understanding over Step 19 files: describe, OCR (untrusted data), ask/search, screenshot analysis, UI-structure extraction, chart and diagram reading, field extraction, comparison, and derived artifacts, with a fixed trust model (provider-fabricated references are dropped; reasoning output is ai-generated and never an action), bounded cancelable jobs, owner-scoped access, Tool System tools with explicit read-only grants, and an Image intelligence page in the web app. The wired provider is the deterministic mock simulation - honestly disclosed in the UI and API; a real vision provider is future work and is not faked.

### AI Provider Gateway and BYOK (Step 26)

The [AI provider gateway](docs/ai-providers.md) lets the platform run on **your** model
account instead of a bundled key. Ten providers are declared (OpenAI, Gemini, Anthropic,
DeepSeek, xAI, OpenRouter, Mistral, Groq, Together, plus a custom OpenAI-compatible
endpoint) behind one catalog; three adapter shapes are implemented for real — OpenAI-compatible,
Anthropic and Gemini — with model discovery, normalized error categories and no silently
advertised capabilities. Credentials are sealed with AES-256-GCM in an owner-scoped vault
with recorded key versions, are decrypted only server-side immediately before an authorized
call, and are never returned by any API, page, log or audit event. Missing encryption
configuration fails closed: writes return 503 and the page shows the blocker rather than
offering a form it cannot honour. Custom endpoints are https-only and SSRF-guarded against
loopback, private, link-local, CGNAT and metadata addresses, re-resolved per request so DNS
rebinding fails. Agents, document reasoning and cross-source synthesis can all run on a
connected provider when a request asks for it (`reasoning: "gateway"`); everything else keeps
its deterministic provider and keeps saying so. `#/settings/ai-providers` covers connect,
verify, default model, replace key, remove, and a metadata-only usage table. A failed
verification reports a normalized reason in plain words (rejected key, rate limited, timed
out, refused endpoint, undecryptable key, unreachable), never a raw code or provider text.

Known limits, stated plainly: usage history is in-process, key rotation is manual (old
versions stay readable), discovery can fail on providers that hide their model list (manual
model ids cover that case), and only chat-shaped providers have adapters — image, audio,
video and embedding providers are declared so the UI is honest, not to imply they run.

### Reasoning engine (Step 27)

The [reasoning engine](docs/reasoning.md) gives the platform a bounded reasoning loop on top
of your connected model: it classifies the task, plans, calls read-only tools through the
Tool System, then answers from what the tools returned. A profile decides which tools a run
may even name, every tool call keeps its existing permissions and confirmation rules, and a
risky call pauses the run until you decide. The record shows the plan, each tool step with
its outcome and duration, the provenance of the answer, the context that was dropped and the
budget actually consumed — and never a hidden chain of thought, which is not requested,
stored or streamed. Limits (iterations, tool calls, wall clock, retries, context size) are
enforced server-side against hard ceilings, and exhausting them reports `limit_reached`
instead of a plausible-sounding answer. Answers state which provider and model produced them;
the deterministic simulated provider is badged "Simulated" and says no model ran.
A finished run is final: cancelling one that already completed, failed or hit its limit is
refused with `REASONING_RUN_NOT_CANCELLABLE` rather than rewriting its recorded answer, and
the stream's terminal event carries the run so the page renders the real outcome.
`/api/reasoning` exposes capabilities, runs, cancel, decision, an SSE event stream and usage,
and `#/reasoning` is the workspace that follows it.

Known limits, stated plainly: runs and usage are in-process and lost on restart; streaming
replays from a bounded buffer, so an older run only shows its final state; context is passed
explicitly by the caller rather than retrieved automatically from project memory; and the
simulated provider proves the loop, not model quality.

### Model routing (Step 28)

The [model router](docs/model-routing.md) is the single place that decides which model runs
a task. It normalizes your connected providers into one catalog, checks what a task actually
needs (`text-generation`, `vision`, `tool-calling`, `large-context`, …), and only then chooses
a model — automatic by fit and readiness, your default, a task preference, a project override,
or an explicit pick. Every decision carries a one-sentence explanation and the models it
rejected with reasons, so "why this model?" has an answer that is not a guess. Categories the
platform cannot serve yet, such as video understanding, are refused with the reason instead of
being approximated by a text model. Reasoning runs and provider generation both route through
it, saving a preference mirrors it into the gateway so the agent layer, coding agent and
document reasoning use the same config, and real outcomes (successes, failures, latencies)
feed outage pausing and the speed preference.

Known limits, stated plainly: cost is never asserted, because no reliable per-model pricing is
configured — a cheaper preference says cost comparison is unavailable rather than inventing a
number; speed ranking needs latencies observed in this session; fallback is opt-in, capability
matched and never retried after a billed attempt; decisions and preferences are in-process and
lost on restart. `#/settings/models` shows the catalog with capability provenance, what each
model cannot do, an "Explain the choice" check that runs the real router, and per-project
overrides. That check is advisory and answers with the decision (including an honest refusal)
instead of an error, and the screen distinguishes "nothing is connected" from "what is
connected cannot run right now" so the two different fixes stay separate.

### Real-model execution (Step 29)

The [execution layer](docs/execution.md) is where a model actually answers. `POST /api/ai/execute`
asks the router which model should run, fits the prompt to the model's window, streams the
provider's own server-sent events back to the browser as `delta` events, and records one usage
row per run: tokens with their provenance, latency, attempts, and a cost only when a price is
declared. Cancelling stops generation on the server, and a closed connection cancels the run so
no provider is left billing for a tab that left. A refusal from the router fails the run with the
refusal; nothing is substituted. Repeating an idempotency key returns the same run instead of
paying twice. `#/execute` ("Model runs") is the surface for it: readiness, the streamed answer,
the route and its explanation, token and cost provenance, and a Stop button that really stops.

Known limits, stated plainly: usage history is in-process and lost on restart, so nothing here is
an invoice; no price table ships, so most models report "cost unknown" until
`VELTRAVIA_MODEL_PRICING` declares one; live execution against a real provider needs a connected
key and was not exercised in the automated suite (those tests use a fixture transport, and the
live tests stay skipped without credentials).

### App Builder foundation (Step 30)

Source files live in Veltravia itself: [native project source storage](docs/source-storage.md)
gives every project per-file history, atomic multi-file change sets, snapshots with restore and
compare, and content-addressed blobs behind a `ContentStore` port that can become object storage
without touching anything above it. GitHub stays optional.

The [App Builder](docs/app-builder.md) is the language-independent foundation for building a
project in the stack you asked for. A capability registry carries 18 languages and 18
frameworks - React, Next.js, Vue, Angular, Svelte, HTML/CSS/JS, Node, Python, PHP, Java, C#,
Go, Ruby, Flutter/Dart, React Native, Kotlin, Swift, C, C++, Rust, SQL, Solidity, Bash - and
records for each what it needs: versions, package managers, build and test commands as argv
arrays, runtime, preview mode, deployment targets and what it explicitly cannot do. A project
specification is validated strictly before anything is planned, detection identifies an
existing stack from file names and manifests, and a deterministic generator produces starter
files for the stacks that have templates. Materializing a plan creates a real project and
workspace through the existing project engine, and implementation work is handed to the
existing coding agent. `#/builder` is the web surface.

Support levels are honest and visible: no technology is `executable` in this release, because
nothing here can compile an arbitrary toolchain. The builder never substitutes a language you
did not choose, and every plan states that its declared build and test commands were not run.

### Frontend builder workspace (Step 32)

[The builder UI](docs/frontend-builder-ui.md) puts those pieces in one workspace:
`#/projects/<id>/builder` shows the real project files (explorer, folders, revisions,
recent changes), a project overview classified by the server into pages, components,
layouts, hooks, styles and assets, and a conversation with the coding agent. A request
starts a bounded coding run; the validated plan is shown before approval, nothing is
written until you approve it, and recorded file changes are reported after the run
finishes. File viewing is read-only in this release - there is no editor yet.

`GET /api/projects/:projectId/source/structure` classifies frontend files from paths
only, and reports `framework: null` when the stack detector recognises nothing instead
of guessing React. `GET /api/coding/capabilities` says plainly whether the API's coding
agent is model-backed or the scripted demo, so the UI never implies a model wrote a plan.
