# Veltravia AI

Veltravia AI is an advanced AI software-development platform. Its long-term goal is a system that can build web and mobile applications, backend systems and APIs, generate and modify code, test and debug projects, connect to multiple AI providers and external services, maintain project memory, and improve itself through a controlled, reviewed self-development process.

**Current development stage: Step 43 complete — bounded Superagent workers and safe parallel scheduling.**

Steps 37 to 41, in short (the paragraph below stops at Step 36 and is kept as written):

- **Step 37, backend deployment and staging.** A health and readiness check, startup that refuses an unsafe configuration, and a manual deploy workflow. Nothing is deployed: no host account, token or domain exists. See [docs/backend-deployment.md](docs/backend-deployment.md).
- **Step 38, the AI workspace menu and the assistant's tools.** The twelve AI tools sit under one menu. The assistant can now reach 64 registered tools (it was 24), granted read and reason only, and it can plan an app with the App Builder. Anything that changes a project or starts work waits for a person to approve the exact input, and the assistant cannot approve its own request. Building and deploying report that nothing was built or deployed, because the sandbox is simulated and no hosting is enabled. The `project.*` tools were not limited to the caller's own projects at the time; Step 40 fixed that (see below).
- **Step 39, AI application testing.** The agent inspects a project, proposes tests, runs them in the sandbox after approval, checks for security problems and writes a report that says only what was proved. A report on the mock sandbox cannot reach "Passed", because no real code runs there. Screen at `#/projects/<id>/testing`. Ownership is now enforced on the older testing routes too. See [docs/application-testing.md](docs/application-testing.md) for what works and what does not.
- **Step 40, native source-code export and GitHub sync.** Download a whole project or a selection as a ZIP, with no GitHub involved. Files are byte for byte; `.env`, key files and anything that looks like a secret are left out and listed by name and reason, never by content. Every export is one project revision or it fails with a conflict. Step 40 also adds optional GitHub sync: connect a project to a repository and branch you already have, compare both sides, settle anything changed on both sides, approve what touches GitHub, then publish as one commit or bring the remote changes in. Secrets are refused rather than shipped, the branch is fast-forward only (no force push), a plan dies if the branch moved, and the history says what moved. Screens at `#/projects/<id>/export` and `#/projects/<id>/github`. Step 40 also closed the ownership gap: every project, workspace, run and tool call is now bound to the caller, and another owner's id gets the same 404 as a missing one. Not included: creating repositories, per-user GitHub sign-in (one operator token and a repository allowlist), pull requests, symbolic links, submodules, LFS, durable storage (Step 41 made projects, workspaces and files durable; archives and sync history are still in memory), real sign-in. The secret check is a safeguard, not a guarantee. See [docs/source-export.md](docs/source-export.md) and [docs/github-sync.md](docs/github-sync.md).
- **Step 41, persistent storage.** Setting `VELTRAVIA_DATABASE_URL` (or `DATABASE_URL`) makes the API keep its data in PostgreSQL 16 instead of process memory. Migrations (three, the last indexes-only) run under an advisory lock before the server listens and a failure stops the boot with exit 78. Projects, workspaces, files, context, integration references, version control (revisions, checkpoints, branches, rollbacks), memories, export jobs and archives, GitHub sync state and run records are now durable: restarting the API no longer loses them, and a second instance reads what the first wrote, proved by tests against a real database. Managers whose ports are synchronous (sync, exports) read through a per-owner mirror filled from the database, with every write queued and flushed before a mutating response is sent, so a 2xx means the row is stored; a failed flush answers 503 `PERSISTENCE_UNAVAILABLE` and says nothing was recorded. A run's control surface stays in the process that started it, but its record (request, status, plan, report, findings) is durable and readable at `GET /api/run-records/:kind/:runId`, which reports `live: false`. Archive bytes live outside the database behind an `ObjectStore` port under `VELTRAVIA_ARCHIVE_DIR` or `<VELTRAVIA_DATA_DIR>/archives`. Not included: authentication (the owner header is still a development stand-in), resuming a run in another process, a retention scheduler, S3/R2 object storage (the download route is synchronous), and multi-instance fan-out of the per-owner mirror. See [docs/persistent-storage.md](docs/persistent-storage.md).

- **Step 42, task orchestration.** Veltravia has one assistant, and this step writes that down: a published contract of the eleven things the Central Primary Agent owns, eight of which can never be handed to a worker, plus a deterministic rule for deciding whether delegating is worth it at all. Tasks get their own records in PostgreSQL (migration 004): identity, owner, project and conversation, a validated lifecycle from `queued` to `completed`, dependencies as a real edge table, append-only events, per-attempt run ids, a retry budget, cancellation and review. Two edges are guarded rather than free: only `retry` returns a failed task to the queue, and only a recorded review completes one, so a worker can never close its own work. Ownership is in the schema as well as the service, another owner's task answers the same 404 as a missing one, and task text that looks like a credential is refused rather than stored. Not included: any worker execution, scheduling or parallelism (Step 43), automatic retry backoff, conflict-safe merging, a screen, and real authentication. See [docs/task-orchestration.md](docs/task-orchestration.md).

- **Step 43, bounded Superagent workers.** The Primary Agent can now hand a bounded piece of a task to a worker: an assignment with a scope, exclusions, deliverables, acceptance criteria, an allowed-tool list, permissions, limits, checkpoints, cancellation conditions and reporting duties, all validated before a record exists. A scheduler starts only work that is genuinely independent, refuses overlapping write claims on the same paths, enforces a concurrency limit, honours dependencies and retry backoff, and records every decision with its reason. Workers move through a validated lifecycle and cannot complete their own work: acceptance requires a recorded Primary Agent review, which then completes the task through Step 42's own review door. Timeouts, cancellation, crashes, stalled heartbeats and bounded retries with backoff are handled and recorded, and everything survives a restart. What a worker actually _does_ is simulated: the shipped executor writes no code and calls no model, and says so in every response. No merge of conflicting work, and no task screen. See [docs/superagent-workers.md](docs/superagent-workers.md). Steps 1–36 are complete (foundation, AI Core, Gemini adapter, connector framework, tool system, agent layer, project engine, sandbox, coding agent, the first real connector, the web UI through live project context in the AI workspace, the integration layer, the app generation engine, the testing & debugging agent, project memory, codebase intelligence, preview & app runtime, version control, file intelligence, image/video/document intelligence, connected-app intelligence, cross-source synthesis, the AI provider gateway, the reasoning engine, multi-model routing, real streaming execution, the native app-builder architecture, native source storage, the frontend and backend builder workspaces, the unified application view, the model-powered coding agent, and the web + Android testing platform): the monorepo foundation, the provider-neutral **AI Core** (`ai/core`) with its mock provider, the **Gemini adapter** (`ai/providers/gemini`, the only code importing the Gemini SDK), the **connector framework** (`connectors/core` + `connectors/mock`), and the **tool system** (`tools/core` + `tools/mock`: schema-validated tool definitions, a permission-gated manager where registration grants nothing, single-use input-bound human confirmations, and a controlled invocation pipeline ending at the ConnectorManager). Step 6 adds the **AI agent layer**: `agent/core` (`@veltravia/agent-core`) — provider-neutral agents that reason about a task, request tools THROUGH the Tool System (never around it), process normalized results, pause for human confirmations, and complete within hard limits (no unlimited loops, no unbounded history); a controlled state machine with terminal statuses, validated decisions (raw model output is never acted on), cancellation, scrubbed audit events, and trust-tagged context that treats tool results as UNTRUSTED DATA — plus `agent/mock` (`@veltravia/agent-mock`), deterministic offline scripted agents, and safe run/confirmation/cancellation API endpoints (`/api/agents…`). The agent is a GENERAL ORCHESTRATOR, not a coding agent: it cannot execute code, touch files, approve its own confirmations, or change its limits (see [docs/architecture.md](docs/architecture.md) and [docs/agents.md](docs/agents.md)). Step 7 adds the **Project & Workspace Engine**: `project-engine/core` (`@veltravia/project-core`) — projects with validated lifecycle transitions (soft delete is terminal), workspaces that always belong to a valid project, and virtual file trees with hardened path security (traversal, absolute, Windows, null-byte, control-character rejection), duplicate/parent/type rules, optimistic revision protection on every mutation, credential-free integration references, deterministic secret-free snapshots, and structured project context/configuration. `project-engine/mock` (`@veltravia/project-mock`) provides deterministic in-memory repositories behind the same interfaces a future database adapter will implement. The engine is PURE STATE MANAGEMENT: no host filesystem access, no execution, no GitHub, no concrete databases. File contents, context, configuration, and metadata are PROJECT DATA — never instructions. A strict API surface (`/api/projects…`, `/api/workspaces…`) exposes it with every rule enforced server-side (see [docs/project-engine.md](docs/project-engine.md)). Step 8 adds the **Sandbox Engine**: `security/sandbox` (`@veltravia/sandbox-core`) — a security-first, provider-neutral execution abstraction. Untrusted code NEVER runs in the API host process: the SandboxManager is a pure orchestrator, and the only executor is the `SandboxRuntime` adapter behind the isolation boundary. Sandboxes have a validated lifecycle (destroyed is terminal; TTL expiry freezes execution), an allowlist-first command policy with a hard denylist and **no shells** (structured `command + arguments` only), environment isolation (the host environment is never inherited — source-scan enforced), a disabled-by-default network policy, complete resource limits with hard ceilings, one-way cancellation with race protection, and bounded, secret-scrubbed output. Sandbox tools ride the Step 5 Tool System (`sandbox.execute` is high risk → forced human confirmation); there is no unrestricted execution endpoint. `security/sandbox-mock` (`@veltravia/sandbox-mock`) is the deterministic offline mock runtime — it executes NO host code and claims NO OS-level isolation; a production container/microVM runtime implements the same interface later (see [docs/sandbox.md](docs/sandbox.md)). Step 9 adds the **Coding Agent**: `coding-agent/core` (`@veltravia/coding-agent-core`) — the file-and-validation specialization of the agent loop. Coding runs are bounded and state-machine-driven: a validated plan that a HUMAN approves before any mutation, decisions that are validated (the model cannot invent tools), file mutations and validations that flow ONLY through the Tool System (deleting a file and sandbox execution are high risk → forced human confirmations), revision discipline (must read or create before update/delete; stale revisions fail typed; the run's sandbox id is never taken from decisions), file content treated as UNTRUSTED DATA (prompt injection gains no authority), secret rejection on every coding input surface, server-side limits with hard ceilings, one-way cancellation, and scrubbed audit. `coding-agent/mock` (`@veltravia/coding-agent-mock`) provides deterministic offline scripted decision sources and a full fixture environment; the API exposes safe run/inspect/cancel/confirmation endpoints (`/api/coding/runs…`) that return only normalized run views — no file contents, no secrets, no chain-of-thought (see [docs/coding-agent.md](docs/coding-agent.md)). Step 10 adds the **first real connector and `invoke_tool`**: `connectors/github` (`@veltravia/connector-github`) — scoped GitHub source control (an explicit `owner/repository@branch` list enforced on every operation), hardened path/branch/sha validation, revision-protected writes, typed scrubbed errors, and an HTTPS-only production transport whose token is read per request and never retained; plus a deterministic offline fake transport so the whole suite runs keyless. The coding agent's optional `invoke_tool` action is allowlist-gated (trusted server-side config only), re-passes the full Tool System pipeline, forces human confirmation for high-risk tools, and replays tool results as UNTRUSTED DATA (see [docs/connectors.md](docs/connectors.md) and [docs/security.md](docs/security.md)). Step 11A adds the **web UI foundation**: a token-based design system (typography, spacing, radius, shadows, borders, restrained motion), a reusable accessible component library (buttons, fields, switches, badges, cards, tooltips, dialogs, menus, tabs, toasts, empty/error states, and more), a light/dark/system theme architecture driven by `data-theme` + CSS custom properties, and a responsive application shell (collapsible sidebar, top bar with account menu, mobile drawer navigation) routing Dashboard / Projects / Settings to clearly-marked placeholder pages — no fabricated functionality (see [docs/ui.md](docs/ui.md)). Step 11B adds the **first real web feature surface**: a typed fetch client (`apps/web/src/api/`) that validates every response and maps it to a safe view model (engine-internal fields never reach React state), and the **Dashboard / Projects / Project detail** pages — project creation (server-assigned ownership), revision-safe editing (409 conflicts are surfaced, never silently overwritten), confirmation-gated archive/restore, status filtering, workspace overview + creation, and honest loading/empty/error states throughout, all backed by the real Project Engine API. Step 11C-1 adds the **AI workspace shell**: a per-project workspace page (`#/projects/<id>/workspace`) with a project context panel, AI conversation surface and composer, and agent/tool activity panels — a responsive three-region layout (side panels become accessible drawers on mobile) with an explicit trust visual language for message origins. It is a visual shell only: nothing calls an AI, tool, sandbox, or connector API, submitted text stays local, the file tree is a labeled illustration, and no functionality is fabricated (see [docs/ui.md](docs/ui.md)). Step 11C-2 wires that workspace to the EXISTING Agent API: submitting the composer creates a real agent run (`POST /api/agents/run` with `{ agentId, task, projectId }`), run statuses map to explicit UI phases, non-terminal states are followed with bounded polling, cancellation flows through the real cancel endpoint and is claimed only on server confirmation, and a completed run's `finalOutput` renders as the assistant message — never a fabricated response, with honest failed/cancelled/limit states and new-run retry. One active run per conversation, generation-guarded against stale responses; the browser remains a pure presentation client (no provider SDKs, endpoints, credentials, or environment reads in web source — test-enforced) (see [docs/ui.md](docs/ui.md) and [docs/security.md](docs/security.md)). Step 11C-3 adds **human confirmations and tool activity to the workspace**: a paused run's pending confirmation becomes an approve/reject card that renders only server-reported metadata (tool id, risk level, state — never the requested input), the decision travels to the real confirmation endpoint, and the Tool System — never the browser — validates expiry, input binding, and permissions before executing or skipping the tool; the activity panel lists recorded tool invocations and the pending confirmation in backend order with tool output treated as bounded UNTRUSTED DATA, every run phase maps to one honest entry, an expired confirmation is terminal in the UI, at most one decision is in flight per run, and a failed delivery keeps the run at its last server-confirmed state with an honest note and a single resync (see [docs/ui.md](docs/ui.md) and [docs/security.md](docs/security.md))). Step 11C-4 gives the workspace **real project context**: run requests carry `projectId` + the selected `workspaceId`, the association is validated server-side against the Project Engine (unknown ids → 404, a foreign workspace → 400, no unchecked association), and the API derives a bounded safe context — project/workspace metadata plus a STRUCTURE-ONLY file tree (paths + types, honest truncation flags, never file contents) — delivered as an explicit `project_context` UNTRUSTED DATA block that is never concatenated into the trusted system prompt. The context panel becomes live (real project metadata, a workspace picker, and the workspace's actual read-only file tree), and the web source never calls file-content endpoints nor mutates files (test-enforced) (see [docs/ui.md](docs/ui.md) and [docs/security.md](docs/security.md)). Step 11C-5 closes the workspace phase with a polish + regression-hardening pass: broken font-weight token references fixed, stale pre-11C-3 copy removed, the conversation becomes a polite `role="log"` live region (announced, never focus-stealing), client-side create failures leave an honest unique system note, the run-status strip aligns with the conversation column, long paths/tool output wrap instead of overflowing, the workspace header becomes a proper `<h2>`, and dead CSS is removed — presentation-only, with no new capability and no trust-boundary change. Step 12 adds the **integration layer**: `integrations/core` (`@veltravia/integration-core`) — declarative integration manifests with strict registry validation, an owner-boundary connection manager (explicit scope grants, validated lifecycle, terminal disconnect), a secret boundary that resolves credentials inside the runtime only (never stored, logged, or returned), and a 13-step fail-closed execution pipeline whose ONLY caller is the Tool System's `connectorExecutor` seam (high-risk operations must arrive Tool-System-confirmed — this layer is a bypass-proof gate, never a second approval path), plus typed scrubbed errors and bounded audit events. `connectors/integration-mocks` provides deterministic offline Storage/Database integrations, the GitHub connector is now an explicit hand-written integration definition, and a catalog + connection API (`/api/integrations…`) plus the web Integrations page (`#/integrations`) expose safe views only — no credential material anywhere (see [docs/integrations.md](docs/integrations.md) and [docs/security.md](docs/security.md) §5i). Step 13 adds the **App Generation Engine**: `generation/core` (`@veltravia/generation-core`) — the idea-to-app pipeline. A natural-language idea is validated and planned by a provider-neutral `GenerationPlanner` (deterministic offline mock today; every planner output is re-validated with strict bounded schemas — malformed, oversized, or secret-shaped input fails closed), the bounded plan view (paths + byte sizes, dependencies, commands, risk summary) is approved by a HUMAN before anything is created, files and directories flow only through the Tool System (explicit minimal server-side grants; nested parents are created idempotently), validation and test commands run through the Step 8 sandbox (the forced high-risk `sandbox.execute` confirmation pauses the run for a human, and a resumed run re-submits the STORED input), a bounded repair loop handles honest validation/test failures, and hard limits with ceilings plus one-way cancellation terminate every run with a typed outcome. `generation/mock` ships the deterministic planner, a declining repair source, and the server-side templates; the API exposes safe normalized run/plan/result views (`/api/app-generations…`) — never file content, host paths, or chain-of-thought (see [docs/generation.md](docs/generation.md) and [docs/security.md](docs/security.md) §5j). Step 14 adds the **Testing & Debugging Agent**: `testing/core` (`@veltravia/testing-core`) — structured test runs over REAL projects in the Project Engine. The agent detects a project's test surface structurally (manifest parsed, never executed; only allowlisted bare executables become commands, shell-shaped scripts rejected), builds a bounded `TestPlan` a HUMAN approves, and executes validation/test/build commands ONLY through the Tool System + Secure Sandbox with forced confirmations. Failures are classified deterministically into a closed vocabulary, diagnosed with a provider-neutral `DebugAgent` under an explicit FACT/INFERENCE/RECOMMENDATION discipline (all outputs re-validated; file contents are UNTRUSTED DATA), and repaired only through the existing Coding Agent behind its own plan approval — within a hard repair limit, with revision conflicts failing typed instead of retried blindly. Hard limits with ceilings, one-way cancellation, scrubbed audit, and safe normalized run views (`/api/testing/runs…`) that never expose file contents, secrets, host paths, or chain-of-thought; the deterministic offline mock debug agent ships today, and an AI-routed one is a one-argument swap (see [docs/testing.md](docs/testing.md) and [docs/security.md](docs/security.md) §5k). Step 15 adds **project memory**: `memory/core` (`@veltravia/memory-core`) — a durable, human-owned per-project fact store with validated lifecycle (active/archived/candidate/rejected), optimistic revisions, secret rejection at every write surface, hard capacity limits, provenance on every record, and a Memory Context Builder that wraps approved facts in a labeled UNTRUSTED-reference-data block before they reach any agent run; AI-extracted candidates from COMPLETED generation/testing runs are NON-AUTHORITATIVE and enter context only after an explicit human approve, memory is server-derived only (the browser never supplies it) and an enhancement, never a gate. `memory/mock` (`@veltravia/memory-mock`) provides the deterministic in-memory repository; the API exposes `/api/projects/:id/memories…` (CRUD, search, archive/restore/verify/stale, candidate review, stats, extraction) with safe normalized views only (see [docs/memory.md](docs/memory.md) and [docs/security.md](docs/security.md) §5l). Step 16 adds **Codebase Intelligence**: `codebase/core` (`@veltravia/codebase-core`) — a structural understanding of a workspace's source, built on the same trust rules as every other subsystem. A build reads source ONLY through the `CodebaseSourceProvider` port (a read of already-authorized project files) and keeps only metadata: languages and frameworks (evidence-backed, confidence-scored), symbols, import/reference/caller/callee relationships, entry points, routes, and components — never file contents or values; secret-shaped files are flagged by path with the values never read into the index, and evidence text is scrubbed. Hard limits with ceilings bound everything (indexed files, symbols, relationships, per-file bytes, build duration, search results, trace depth/nodes) and truncated responses say so honestly. Eight read-only tools (`codebase.search`, `find_symbol`, `find_references`, `find_callers`, `find_callees`, `trace_feature`, `get_summary`, `get_file_symbols`) ride the Step 5 Tool System (permission `codebase.read`) — agents have no other path to the index. Completed indexes can contribute bounded structural facts to project memory as NON-AUTHORITATIVE candidates under the Step 15 human-approval rules. `codebase/mock` (`@veltravia/codebase-mock`) provides the deterministic in-memory repositories; the API exposes `/api/projects/:id/codebase…` (index, build, search, trace, summary, per-file symbols, memory-candidate extraction) with safe normalized views only, and the web workspace gains a Codebase analysis panel (desktop side panel + mobile drawer) that shows index status, stats, search, feature traces, and flagged-secret counts — never source content (see [docs/codebase.md](docs/codebase.md) and [docs/security.md](docs/security.md) §5m). Step 17 adds the **preview / app runtime**: `runtime/core` (`@veltravia/runtime-core`) — a validated evidence-based plan → build → start → health-check → serve lifecycle for generated apps. Plans are DETECTED from workspace evidence (manifest scripts, frameworks, present files, codebase index) and validated server-side with structured allowlisted commands, bounded limits with hard ceilings, and secret-shaped environment rejection; the browser never supplies commands, ports, limits, or environment values. Runtimes are revision-bound to their workspace (staleness is reported honestly, start fails typed on revision mismatch, restart rebuilds at the LATEST revision), live within validated state-machine transitions, one-way cancellation, idle + lifetime expiry through a sweep, hard ceilings, structured failure reports, and bounded scrubbed logs. The RuntimeExecutor seam is the ONLY execution path — the API server is NEVER the runtime — and `runtime/mock` (`@veltravia/runtime-mock`) is the deterministic SIMULATED executor (full failure matrix, honestly labeled everywhere, NO OS-level isolation claims); a production container/microVM executor implements the same interface later. The preview page serves only through the platform-controlled `/preview/:runtimeId` URL with sandboxing headers, and the Project Detail page gains a Preview panel (create/start/stop/restart, honest status/plan/failure/logs, bounded slow-follow). Runtime facts flow into project memory as NON-AUTHORITATIVE candidates under the Step 15 human-approval rules (see [docs/runtimes.md](docs/runtimes.md) and [docs/security.md](docs/security.md) §5n). Step 18 adds **version control**: `version-control/core` (`@veltravia/version-core`) — an append-only revision history for every workspace. Each revision is a content-addressed, integrity-verified snapshot of the whole tree (corruption fails closed, never silently degrades), with bounded line diffs, named advisory checkpoints (deleting a marker never touches a revision or file), honest retention with hard ceilings and protected-revision counting, and TWO-PHASE rollback: a restore is a REQUEST guarded by `expectedCurrentRevision` optimistic concurrency that PAUSES for a human confirmation, executes step by step through the normal file-tree operations, and APPENDS a new `rollback`-source revision — history is never rewritten. Rollback runs at critical risk through the Tool System (forced confirmation, no bypass path); every capture/restore/checkpoint/retention event lands in the scrubbed audit trail. Coding, generation, and testing runs are now bracketed by BEST-EFFORT route-level captures (a capture failure never fails the run). `version-control/mock` (`@veltravia/version-mock`) is the deterministic in-memory store; a production store implements the same `VersionStore` port later. The API exposes timeline/diff/compare/checkpoint/rollback endpoints as safe normalized views, and the Project Detail page gains a Version History panel (capture, diff dialog, checkpoints, restore with an explicit confirmation dialog that states nothing is lost) (see [docs/version-control.md](docs/version-control.md) and [docs/security.md](docs/security.md) §5o).

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

## Trying it on a phone

[The testing platform](docs/testing-platform.md) packages the same web application as
an Android app: Capacitor wraps `apps/web/dist`, CI builds the APK on every push, and
the bundle finds its backend through a public `runtime-config.json` rather than a
build-time secret. With no backend URL configured the app says so plainly instead of
pretending to work; it needs a deployed API and a physical-device pass before it is
usable by anyone else.

## Watching a run work

[Live agent activity](docs/live-agent-activity.md) replaces the single spinner with
the run's own record: a normalised event, a snapshot endpoint and an SSE stream, rows
derived server-side from the tools that actually ran, an expandable `Command` /
`Output` inside each row, and a final report that separates what was done from what
failed and what is still open. The browser never invents a phase, a finished row can
never be reopened by a late event, and a dropped stream resumes from the last
sequence it saw.

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
10. **Web UI** _(done)_ — an assistant chat at `#/chat` (the front door: greeting, suggestions, a composer wired to the reasoning engine), plus dashboard, projects and the live AI workspace: runs, human confirmations, tool activity, real project context (Steps 11A–11C-5)
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

### Backend builder workspace (Step 33)

[The backend builder](docs/backend-builder.md) is the same idea pointed at the server:
`#/projects/<id>/backend` reads the project's own files and describes the routes, database,
models, functions, authentication, environment variable names and log availability it finds.
Every route opens to the file, line and declaration it came from. Where a capability does not
exist in this release the panel says so - the database reports `not-configured`, logs report
`unavailable` with a reason, and a route whose file shows no guard reports `unknown` rather
than `public`.

The AI panel is the same coding agent and the same approval gate as the frontend builder, so a
backend change is still a bounded run you approve before anything is written. `GET
/api/projects/:projectId/backend` (plus per-section routes and `/api/backend/capabilities`)
is read-only; environment variables are collected by name only, and quoted evidence is
redacted before it leaves the scanner.

### Unified application workspace (Step 34)

[The unified workspace](docs/unified-app-builder.md) at `#/projects/<id>/app` presents the
frontend builder, the backend builder, the database view, the API surface, the files and the
assistant as one application. It adds no store and no AI system: one bounded pass over the same
source tree feeds the overview, the grouped file explorer, the health panel and the cross-layer
graph.

`GET /api/projects/:projectId/app` composes the view, with `/overview`, `/files`, `/links` and
`/health` slices, and `POST /app/group` classifies the paths a plan would touch. Health uses six
words only - `configured`, `detected`, `tested`, `running`, `unavailable`, `not-configured` - so
"a provider is declared" is never reported as "the database works", and no test run is claimed
without one. Cross-layer edges (frontend request to backend route, route to handler, handler to
model, route to auth) each carry a file and a line at both ends; a request with no route is
listed as unmatched with its reason, and a route nobody calls is reported without being called
broken.

### Model-powered coding (Step 35)

The coding agent behind every Build surface now plans and implements with a **real model**.
[Model-powered coding](docs/model-powered-coding-agent.md) is one completion port implemented on
the existing execution service, so the router still chooses the model, the gateway still decrypts
the credential for one request, and usage is still recorded once. Nothing else moved: the model
returns JSON, the agent validates it, the Tool System authorises it, the Project Engine applies
it, and a human still approves the plan before a single file is written.

`GET /api/coding/capabilities` answers per caller - `model`, `unavailable` with a plain reason, or
`scripted-demo` only when the server was started with `VELTRAVIA_CODING_DEMO=1`. With no provider
connected, `POST /api/coding/runs` refuses with `409 CODING_MODEL_UNAVAILABLE` rather than quietly
falling back to a script. Run payloads carry `phase`, `plan.origin`, the answering provider and
model ids, and each validation's real outcome - so the builder can say "Planned by OpenAI ·
gpt-4.1-mini" or "no model connected" and mean it.

A model-authored patch must match exactly one location in a file it has already read, and
cancelling a run aborts the in-flight model call instead of only discarding the answer.

A run makes one model call per decision, so it meets rate limits a chat turn never would. The
gateway waits as long as the provider asks (capped at 20s), waits at least 5s on a 429 that states
no wait, and names the provider's own reason - an exhausted daily quota reads as one. Metered keys
can also pace decisions with `VELTRAVIA_CODING_MODEL_MIN_INTERVAL_MS`. What none of that does is
make a spent quota work; the run ends as a typed failure that says so.

## Step 44 - model-powered Superagents

Workers think with a real model through the existing AI gateway, use only the tools
their assignment named, stay inside their path scope and return evidence plus usage.
`SimulatedExecutor` still exists but is opt-in (`VELTRAVIA_WORKER_EXECUTOR=simulated`).
What is real and what is not is enumerated in `docs/superagent-execution.md`.

## Step 45 - sandbox verification and evidence

Workers can now run the project's own checks - unit, integration, e2e, typecheck, lint,
format, build, dependency audit - in a sandbox, and the result is recorded as a run with
argv, exit codes, counts and evidence rather than a claim. Operations are resolved from the
project's configuration, never from a tool argument, and a worker may only ask for the
operations its assignment lists. Acceptance of a worker that claims a test result is
refused unless a stored run backs the claim, with the recorded status agreeing.

No operating-system isolation is provided by the local runtime and every record says so;
with no runtime configured a run is stored as having executed nothing. Details, routes and
configuration: `docs/sandbox-verification.md`.

## Step 46 - conflict-safe change integration

A worker's writes no longer land in the project. They are staged as a change set against
the revision the worker started from, validated (scope, exclusions, credential-shaped
content, size, base hash), and integrated only after a recorded approval. Two proposals
that touch the same path, overlap inside a file, race a delete or rename, or disagree
about a schema are refused rather than merged, and a cross-process project lock means one
integration runs at a time. Details: `docs/change-integration.md`.

## Step 47 - Superagent operations dashboard

One page, `#/operations`, over everything Steps 42-46 record: the fleet by status, each
Superagent's assignment, progress, deliverables, evidence, usage and review, task
coordination, staged change sets with both sides of every file, verification runs, the
integration history and the scheduler's own decisions. It reads and never starts work;
cancel, re-queue, review, approve and integrate call the existing routes, and a refusal is
shown in the server's words. The page polls and says so rather than pretending to be live.
Details, including the one new read (`GET /api/change-sets/:id/diff`): `docs/operations-dashboard.md`.

## Step 48 - autonomous repair, retry and recovery

A failed Superagent is now diagnosed from what was actually observed - status, failure code,
declared against produced deliverables, review refusals, verification results, attempt
history - and repaired inside stated limits. `@veltravia/recovery-core` classifies the
failure and grades its own confidence; with no usable signal it escalates as
`insufficient_evidence` instead of inventing a cause. A repair inherits the failed
assignment's checks and permissions but never widens them, runs on a child task so the
failed task keeps its record, and the superseded worker is cancelled so its resource claims
are released. A case becomes `recovered` only when a stored verification run passed and the
change set is integrated or preserved; a claim alone is refused. Migration 008 stores cases,
attempts and an append-only event trail, and `resume` rebuilds a case after a restart without
double-advancing it. Details: `docs/recovery-orchestration.md`.

## Step 49 - recovery operations dashboard

The recovery records appear on `#/operations`: a tally over the owner's cases, filters the
server applies (status, failure category, verification outcome, worker, project, date), and
a case view that keeps observed facts and inferred diagnosis in separate columns. Every
repair attempt is listed with its child task, its worker, its verification run and the
attempts left. A case is only displayed as recovered when a stored verification run both
executed and passed; a record that claims recovery without that evidence is shown as
awaiting verification with a warning. The page reads and never repairs - re-read, re-diagnose
and cancel are the only controls, and all three are existing routes. Details:
`docs/recovery-dashboard.md`.

## Step 50 - end-to-end autonomous execution

A sentence becomes a delivered, reported piece of work. `@veltravia/execution-core` takes the
request, plans it against the project's real files, and drives the existing engines: the task
engine creates the work, the worker engine runs it, verification proves it, integration lands
it and recovery picks up what breaks. Nothing is invented along the way - progress is
recomputed from stored task, worker and verification records on every sync, so work that is
waiting for the owner reads "needs review" and a task without a stored passing verification
run says so instead of implying a proof. Delivery is reported as complete, partial, blocked or
failed with the verification runs that back it. Executions are stored in PostgreSQL
(migration 009) and owner-scoped end to end. The Executions region of `#/operations` shows the
plan, the per-task state and the delivery report, and its only controls are the existing
dispatch, sync, review and cancel routes. Details: `docs/execution-orchestration.md`.

## Step 51 - production reliability, idempotency and crash-safe orchestration

The machinery around the work is now guarded. `@veltravia/reliability-core` adds three
primitives and a sweep, and none of them execute or complete anything: they decide whether a
request already ran, whether anyone still holds a resource, and what happened to work that was
interrupted. A mutating request may carry `Idempotency-Key`; the first answer is stored and
replayed, a retry while the first is still running gets 409, and the same key on a different
body is refused instead of being silently treated as a new request. Leases are one atomic
statement on a resource, so two API instances cannot advance the same execution, and expiry is
treated as evidence of absence rather than proof of failure. The sweep re-reads the stored
records before deciding: it resumes what someone is still holding, recovers what is genuinely
abandoned, waits when the work is waiting for a person, and leaves what it cannot prove - it
can never mark a task done, accept a deliverable or approve an integration. Health, decisions,
keys and outstanding side effects are readable under `/api/reliability`, and the Reliability
region of `#/operations` shows them. When no database is configured the state is in memory and
the snapshot says so with an amber finding instead of a green tick. Details:
`docs/production-reliability.md`.

## Step 52 - backend usage metering and infrastructure quotas

The platform can now say what an owner used this month and what happens at the line. A record
is written only where a number is already known - a queued job at intake, a worker's measured
wall clock at review, the tokens a run reported - so metering never becomes a second source of
truth. Three distinctions are load-bearing. Counters (tokens, milliseconds, jobs) accumulate and
come from the ledger, while gauges (file bytes, open jobs) are probed as they are now, because
summing monthly storage rows would keep charging for a deleted file. A limit that nothing in the
deployment measures is published and reported as **not enforced** rather than drawn as a bar:
database storage, bandwidth and realtime fall there today. And provider spend is never added to
infrastructure spend - a BYOK call is the caller's own provider bill, recorded for transparency
and excluded from what an allowance spent. Intake is refused with `429 USAGE_LIMIT_REACHED`
before anything is planned, a worker start is refused past the concurrency limit, and a managed
provider key would need a paid plan. The Usage region of `#/operations` shows the month, the
limits, both cost columns and the recent records. Plan and limit changes are operator work
behind `VELTRAVIA_USAGE_ADMIN_TOKEN`, and the routes fail closed when it is unset. Details:
`docs/usage-metering.md`.

## Step 53 - Credit wallet

Veltravia credits are held in a ledger-backed wallet (personal and per workspace) with
atomic deductions, reservations, refunds, reversals and reconciliation. Billable metered
usage from Step 52 is charged exactly once, at a documented and configurable rate; a user's
own provider spend is never converted into credits. See `docs/credit-wallet.md`.

Not delivered: payment processing or real-money credit purchases. `purchase` is an entry
kind, not a working checkout.

## Step 54 - message credits

Each billable AI interaction is priced by a configurable policy, held against the wallet
before the provider is called, and settled against what was actually measured. Rates are
**configurable defaults, not market prices**, and the policy endpoint says which it is. A
hold taken before a run is a floor, not a cap: a measured charge above it is drawn from
available in the same atomic transition, and a hold whose operation never came back is
swept. Missing measurements are recorded as limitations rather than filled with a guess,
and a BYOK interaction is never charged for its tokens. See `docs/message-credits.md`.

Not delivered: payment processing or real-money purchases of credits; token rates only
apply to a managed-key deployment.

## Step 55 - coding and agent credit integration

Coding runs and agent workers are now billed the same way a chat message is. One operation
opens one hold before any planning or model call, every model turn inside the run is tallied
against that same operation, and the run settles once when it ends. A cancelled run, a
refused worker and a stalled worker release their hold instead of leaving it to the sweep,
so a half-finished plan costs nothing. A worker that cannot be paid for is refused before it
claims anything, with the real credit error rather than a generic failure.

Cached tokens are measured, not guessed: the gateway's cached count is taken from the
provider's report, billed at the cache rate, and the saving is recorded on the charge beside
the tokens it came from. A charge also remembers which reporter produced its numbers, and
that survives a restart. See `docs/operation-billing.md`.

A workspace is a label for reporting, not a second purse. A workspace wallet that somebody
has funded pays for its own work; an unfunded one bills the account holder, because charging
an empty workspace wallet refused work the account could plainly afford.

Not delivered: no payment processing, no per-seat workspace funding flow, and the token
rates still only bite on a managed-key deployment.

## Step 56 - integration credits and connector usage billing

Third-party work is now priced, held and settled the way model work already was, and kept
visibly separate from it. Every integration, connector, plugin and external-service
operation is classified before it runs: **free**, **paid** (Veltravia supplies the
credential, so the operation is priced in credits) or **externally billed** (the service
charges the user's own account, so Veltravia charges nothing unless a policy explicitly
says it may). A free integration and a service billing the user directly are recorded as
exempt with the reason, never as a silent zero.

Billable operations take a hold before the call and settle against the platform's own
measurement (one dispatched operation and its wall clock). A refused hold happens before
anything external runs; a failure, timeout or cancellation releases the hold instead of
leaving it to the sweep. A retried operation carrying the same idempotency key finds its
first charge instead of paying twice, and every charge names its owner, workspace, project,
integration, connector, operation, connection and execution.

A measurement nobody reported stays unknown: the charge records `request-count-unavailable`
rather than counting as zero usage. The rates are **configurable defaults, not market
prices**, per integration, per operation and per plan, and the policy endpoint says which.
The operations dashboard gained an integration-credit panel: balance and holds, the three
billing classes, the rate table, spending limits, where the credit went, and the charge
ledger with its limitations. See `docs/integration-credits.md`.

BYOK stays excluded: a call made with the owner's own provider key is exempt and says so, so
provider spending is never converted into platform credits.

Two things that were gaps were then closed. A settled charge can be **refunded**: an operator
enters the token at the moment of the refund, it is never stored, `ownerRef` defaults to the
caller, and the dashboard only shows the control when the deployment reports that refunds are
open. And the hold sweep now runs **on a schedule** (default every 5 minutes, `0` disables)
instead of waiting for somebody to remember: it releases expired holds for every account that
still holds credit, never settles or charges, never stacks ticks on a slow sweep, survives a
failed tick, and stops with the app. Neither touches money: a refund returns credits, and a
real subscription refund belongs to the store that took the payment.

Plans bundle credits, not just limits: four paid tiers sit above the development allowance and
each one carries a monthly integration allowance and a monthly message allowance, published by
the policy route as configurable defaults with a note saying they are neither prices nor an
offer. An allowance is a ceiling, not a deposit - credits still arrive in the wallet - and when
an account sets no limit of its own, its plan's allowance becomes the ceiling and the summary
says the plan supplied it. `VELTRAVIA_PAID_PLAN` names which tier `paid` maps to, defaulting to
the middle one; an unrecognised value is logged and ignored.

Not delivered: no payment processing or real-money purchase of integration credits, no
per-integration funding flow, no separate admin console for refunds. Charges file under the
owner that owns the connector connections, which is the deployment's owner; a real auth layer
would pass the caller through the same seam.

## Step 57 - unified automatic deduction and infrastructure usage billing

Steps 52 to 56 each built a correct answer to one question, and three things were still
true: a reasoning run and an agent run made real provider calls and were priced by
nobody, nothing asked whether an account could afford an operation before starting it,
and the three infrastructure categories Step 52 published as unmeasured stayed that way.
This step is the coordinator over those engines - no second wallet, no second price
table, no second ledger.

`GET /api/billing` publishes what each operation is: **charged** (chat, coding, worker,
agent run, reasoning run, connector), **metered** (background job intake, which makes no
paid call of its own) or **BYOK exempt with a reason** (document jobs, intelligence
synthesis). A charged operation holds credit through the Step 53 wallet before it starts
and settles through the Step 55 operation charge, so one operation is one charge however
many model calls it makes.

A refusal is `402 BILLING_INSUFFICIENT_CREDITS`, and it says which operation was blocked,
what it cost, what the wallet has, the shortfall, and the four things the person keeps:
projects, files, settings and conversation history. Nothing runs, so nothing is spent. A
refused worker keeps its task and checkpoints rather than being thrown away, and no route
quietly substitutes a free unauthorised path for the work that was blocked.

Storage, bandwidth and realtime are now measured, and the capability table asks the
server whether it observes them instead of hardcoding a status, so a category cannot
claim to be measured because the code changed while the wiring did not. Sizes come from
the file manager's own record, bandwidth is one record per owner per minute instead of
one per request, and a realtime stream is counted when it closes with its duration and
events. `recordUsage()` refuses a negative, non-finite or unkeyed measurement rather than
writing a row, and an unknown size is measured as nothing rather than zero.

Two silent bugs this work surfaced are worth naming, because both looked healthy: the
stored-bytes gauge read a field that does not exist on a file asset (`byteLength` instead
of `metadata.byteSize`) and had been a permanent zero, and `usage.records(ownerRef)`
filtered by nothing on the in-memory store, answering one account with another's rows. A
fourth Step 54 constraint also had to be widened by migration 016, which is why an agent
run answered 500 "schema constraints" until the new charge kinds were allowed.

`GET /api/billing/reconcile` compares the lanes for one account and reports the wallet's
ledger sums, any committed charge whose wallet entry is missing, and the open holds, and
`GET /api/billing/usage` is the fleet view with the live meter. Reconciliation reports and
never moves money. Idempotency is the operation id, so a retried request or a restarted
worker finds its charge instead of paying twice, and the scheduled hold sweep from Step 56
still releases anything that outlives its operation. See `docs/unified-billing.md`.

Not delivered: no payment processing, so credits arrive through the operator route; no
Veltravia price for document jobs or intelligence synthesis, which stay exempt with an
`open()` extension point; and storage and bandwidth remain floors, since bytes written by
another process or served by a CDN never pass through this API.

## Step 58 - usage history and cost dashboard

Steps 52 to 57 each wrote down what something cost. Four panels on the operations page
could answer four questions, and nothing could answer the fifth: what have I used in
total, and where did it go? This step is one read-only layer over the records that already
exist. No second ledger, no second price table, no new charge.

`GET /api/usage-history` returns one merged feed across message charges, integration
charges and infrastructure measurements, filtered in the database by date range, category,
status, project, model, provider and text. `GET /api/usage-history/overview` carries the
wallet's own balance, this billing period, the selected range, recent events, the
infrastructure strip and the wallet's ledger summary. `GET /api/usage-history/breakdown`
groups by category, project, model, provider, day, month or activity, and
`GET /api/usage-history/export.csv` is the same filtered rows as a download.

Three rules make the numbers trustworthy. **The balance is the wallet's**: available, held
and spent are copied from the ledger, never recomputed, because a second way of computing a
balance is a second balance. **A hold is not a charge**: every event carries a movement -
held, charged, released, refunded, not charged, measured - and only a deduction moves
credits, so a running reservation cannot look like spending. **A partial sum says so**:
each aggregation reads up to a configurable cap and reports `complete: false` with the
number of rows read when it stops early, instead of presenting a total that looks whole.

Getting the paging right took three attempts and is worth naming. The first cursor carried
a prefixed id (`charge:…`) into a comparison against raw ids, so page two silently came
back empty; the second used a timestamp alone, which drops every charge written in the
same millisecond as the boundary - common whenever a run settles several at once. The feed
now carries a per-lane keyset boundary (the last row shown in each lane), the in-memory
stores break ties by id so they order rows the way the SQL does, and `total` is counted
without the boundary so it does not shrink page by page.

The page is `#/usage`, "Usage & cost", in the existing navigation and design system: four
summary cards, the filters, usage by category as bars, daily credits as a compact chart,
the history table with real loading, empty, error and partial states, the largest charges,
the measured infrastructure strip and this period's figures. Below 900px the grid stacks
and below 640px the table becomes labelled blocks, so a phone reads one record at a time.

Credits are not money and nothing here pretends otherwise: no currency conversion, no cash
figure, and the pricing note names the catalog version and whether the policy is
defaults-only. See `docs/usage-history.md`.

Not delivered: no payment processing or invoices; no workspace credit allocation, so
`workspaceId` narrows reads without funding anything; storage and bandwidth stay floors,
since bytes written elsewhere or served by a CDN never pass through this API; token counts
appear only when the provider reported them, and the row says what was not measured rather
than estimating it.

## Step 59 - spending limits

Ceilings on what an account may spend in a window, checked **before** credit is held, plus
the per-operation and held-credit ceilings that make one runaway operation survivable.
`@veltravia/spending-limits-core` holds the decision and the window arithmetic; the API
binds it to the two charge lanes and the wallet; the screen is a panel on Step 58's `#/usage`
page rather than a fifth dashboard, because a limit belongs beside the numbers it bounds.

Four rules, each of which the tests assert: **a hold counts against the allowance**
(`consumed = committed + held − refunded`) so parallel reservations cannot slip past a check;
**the tightest scope wins**, so a project limit cannot be escaped by a generous personal one;
**soft and hard are different promises** (a soft rule writes one warning per threshold per
window, a hard rule refuses with `402` before any hold exists); and **a stale write is
refused**, not forced, so two tabs cannot overwrite each other. A policy, its events and its
audit trail are in the database (migration 017), so a restarted instance enforces the same
limit.

The race that the first version lost is the interesting part. Eight simultaneous requests all
read the same untouched allowance and all eight passed, because nothing held the window still
between reading it and taking the hold. The fix is a per-owner guard around that pair:
`pg_advisory_xact_lock` on a dedicated two-connection pool for Postgres, a promise chain per
owner in memory. Putting that lock on the request pool deadlocked it at saturation (every
request held one connection for its lock and needed a second to work), and wrapping the
callback in a transaction turned a `402` refusal into a `500`; both are fixed, and the
persistence test fires six requests across two instances and lands exactly three accepted and
three refused. See `docs/spending-limits.md`.

Not delivered: no payment or plan gating; no automatic suspension when a limit is reached; no
workspace funding (workspace and project scopes bound spending the owner's wallet pays for);
the guard is per lane, so an `all` rule spanning messages and integrations can be passed by
up to one operation's worth in the worst case; and the screen offers daily, weekly and
monthly windows only, though the API also accepts custom day counts.

## Step 60 - subscription plans

Plans are rows, not constants. `@veltravia/subscriptions-core` holds the catalogue, the
entitlement reader, strict plan validation and the clock-driven lifecycle; the API binds it to
migration 018 and to a plan gate installed over every protected route family; the screen is
`#/plan`.

Four rules the tests assert: **an absent entitlement is denied**, so adding a feature closes it
on a plan that was never granted it; **a renewal runs once per period**, claimed by an insert
into `subscription_periods` keyed on the period being _granted_; **a plan change keeps the
period, the credits and every project**, in both directions; and **a suspension grants nothing**,
neither a managed key nor a personal one, refused in the meter before any provider call. The
four paid allowances are Step 56's numbers carried forward unchanged (2,000 / 10,000 / 20,000 /
50,000) as configurable defaults, and a test fails if the two tables ever disagree.

The bug worth recording is the renewal claim. The first version keyed it on the period that had
just ended, which the assignment had already written, so every renewal collided with the
account's own first row and silently did nothing - a subscription advanced 32 days reported
`applied: 0`. The lifecycle test found it; the claim now names the new period. The plan insert
had a parameter-count mismatch that left the catalogue unseeded in Postgres while the in-memory
store looked perfect, which is why the persistence suite runs against the real database.

No price is stored, shown or implied, and there is no checkout: self-service changes are closed
by default, because a plan change with no payment behind it is a free upgrade. See
`docs/subscriptions.md`.

Not delivered: no payment, checkout, invoices or proration; no trial automation; no seat or
member model (a subscription belongs to one owner ref); no scheduled renewal timer - the sweep
route exists and whoever schedules it must call it; no admin UI (the operator surface is HTTP
only).

## Step 61 - payments, invoices and billing

A plan can be bought. `@veltravia/payments-core` holds integer money, the price book, three
provider adapters (Paystack, Flutterwave, Monnify), the webhook rules, invoices, receipts and a
PDF writer; migration 019 and `PostgresPaymentStore` persist it; the API is
`apps/api/src/payment-service.ts` plus `routes/payments.ts`; the screen is `#/billing`.

The rules the tests assert are all about not believing a browser. **The amount is decided on the
server** - the checkout body names a plan, an interval and a provider, and a test asserts no
amount field survives into it. **A redirect is not a receipt**: `?reference=` only starts a
verification, which checks reference, amount, currency, status and the owning account before a
plan is granted. **A reference is single-use**, enforced by a unique constraint, so a second
delivery of one charge cannot buy a second period; the Postgres suite proves it with two
simultaneous inserts. **A webhook is proved by its signature** over the exact request bytes, with
a replay window and a `(owner-or-global, dedupe_key)` unique row, so a redelivery reports
`duplicate: true` and changes nothing. **An invoice is issued as a snapshot** from an atomic
counter, and editing a price afterwards does not rewrite it.

The two bugs worth recording are both about money moving without an entitlement moving with it.
Renewal first charged before the paid period had ended - collecting for time already paid for, and
granting nothing, because Step 60's lifecycle correctly refuses to advance a period that has not
finished; `chargeRenewal` now refuses early instead. And a refused webhook delivery consumed the
canonical dedupe key, so a provider whose secret was misconfigured and then fixed had every retry
of that event refused for ever; a rejected delivery is now recorded under its own key.

Recurring billing is only offered where the provider can do it: Monnify cannot charge a stored
authorization, so its renewal is a fresh checkout link and the screen says so. Tax is configuration
and ships empty - with no rate configured, none is added and the screen says nothing here is tax
compliant. The operator surface (providers, prices, discounts, taxes, refunds, reconciliation,
events, audit) sits behind `VELTRAVIA_BILLING_ADMIN_TOKEN` and answers `503` when unset rather than
falling open. See `docs/payments.md`.

Not delivered: no tax compliance or filings; no credit top-ups; no dunning scheduler (grace,
reminders and `renewalsDue` are readable, and whoever operates the deployment schedules them); no
proration on an upgrade; no seat or workspace membership model; no operator UI; no Play Billing in
the Android build.

## Step 62 - the first second, and a panel that narrows to its icons

Two pieces of the shell, both measured against Base44's web app rather than guessed at. Nothing
about the assistant changed; this is how the page arrives and how its navigation behaves.

**The page paints its own frame before React exists.** It used to be blank until the bundle and
`runtime-config.json` had both arrived - over four seconds on a throttled phone - where the
reference draws its frame immediately and fills it in. `apps/web/index.html` now carries a static
frame inside `#root`: a 56px top bar, the navigation column from 901px up, 47px rows and the
message box, drawn with quiet placeholder bars, following the visitor's light or dark theme via the
same storage key `ThemeProvider` writes. It carries no data, no name and no number, is
`aria-hidden`, and the first React commit replaces it; its stylesheet is removed two animation
frames later so the frame never flashes unstyled on the way out. `apps/web/src/boot-shell.test.ts`
fails the build if the frame's colours, sizes or theme key drift from `tokens.css`, `shell.css`,
`mobile-drawer.css` or `chat.css`.

**The navigation panel narrows to its icons.** The control at the head's right collapses it: 324dp
to 60dp over the page, 380dp to 60dp docked, with the page shifting to match. Labels are hidden
visually and stay in the accessibility tree, so every row keeps its name; the mark takes the
control's place in the head and tapping it opens the panel again. A phone's drawer forgets the
narrowing when it closes (it is a transient state); the docked column keeps the choice its owner
made, which is why the reset is guarded on `docked`.

**The menu says it is reading, instead of saying it is empty.** The conversation list starts as
`null` - "not read yet" - and shows three placeholder rows until storage answers and the agent's
name has been fetched, with `aria-busy` on the section and the app's existing breathing animation
(honoured by `prefers-reduced-motion`). No minimum display time is faked: the bars vanish as soon
as the real state exists.

Still open: sending a message with attachments is refused, because the run API takes text only, and
the web bundle is a single 887KB chunk.
