# Veltravia AI

Veltravia AI is an advanced AI software-development platform. Its long-term goal is a system that can build web and mobile applications, backend systems and APIs, generate and modify code, test and debug projects, connect to multiple AI providers and external services, maintain project memory, and improve itself through a controlled, reviewed self-development process.

**Current development stage: Step 8 — Sandbox Engine.**
Steps 1–11C-5 are complete (foundation, AI Core, Gemini adapter, connector framework, tool system, agent layer, project engine, sandbox, coding agent, the first real connector, and the web UI through live project context in the AI workspace): the monorepo foundation, the provider-neutral **AI Core** (`ai/core`) with its mock provider, the **Gemini adapter** (`ai/providers/gemini`, the only code importing the Gemini SDK), the **connector framework** (`connectors/core` + `connectors/mock`), and the **tool system** (`tools/core` + `tools/mock`: schema-validated tool definitions, a permission-gated manager where registration grants nothing, single-use input-bound human confirmations, and a controlled invocation pipeline ending at the ConnectorManager). Step 6 adds the **AI agent layer**: `agent/core` (`@veltravia/agent-core`) — provider-neutral agents that reason about a task, request tools THROUGH the Tool System (never around it), process normalized results, pause for human confirmations, and complete within hard limits (no unlimited loops, no unbounded history); a controlled state machine with terminal statuses, validated decisions (raw model output is never acted on), cancellation, scrubbed audit events, and trust-tagged context that treats tool results as UNTRUSTED DATA — plus `agent/mock` (`@veltravia/agent-mock`), deterministic offline scripted agents, and safe run/confirmation/cancellation API endpoints (`/api/agents…`). The agent is a GENERAL ORCHESTRATOR, not a coding agent: it cannot execute code, touch files, approve its own confirmations, or change its limits (see [docs/architecture.md](docs/architecture.md) and [docs/agents.md](docs/agents.md)). Step 7 adds the **Project & Workspace Engine**: `project-engine/core` (`@veltravia/project-core`) — projects with validated lifecycle transitions (soft delete is terminal), workspaces that always belong to a valid project, and virtual file trees with hardened path security (traversal, absolute, Windows, null-byte, control-character rejection), duplicate/parent/type rules, optimistic revision protection on every mutation, credential-free integration references, deterministic secret-free snapshots, and structured project context/configuration. `project-engine/mock` (`@veltravia/project-mock`) provides deterministic in-memory repositories behind the same interfaces a future database adapter will implement. The engine is PURE STATE MANAGEMENT: no host filesystem access, no execution, no GitHub, no concrete databases. File contents, context, configuration, and metadata are PROJECT DATA — never instructions. A strict API surface (`/api/projects…`, `/api/workspaces…`) exposes it with every rule enforced server-side (see [docs/project-engine.md](docs/project-engine.md)). Step 8 adds the **Sandbox Engine**: `security/sandbox` (`@veltravia/sandbox-core`) — a security-first, provider-neutral execution abstraction. Untrusted code NEVER runs in the API host process: the SandboxManager is a pure orchestrator, and the only executor is the `SandboxRuntime` adapter behind the isolation boundary. Sandboxes have a validated lifecycle (destroyed is terminal; TTL expiry freezes execution), an allowlist-first command policy with a hard denylist and **no shells** (structured `command + arguments` only), environment isolation (the host environment is never inherited — source-scan enforced), a disabled-by-default network policy, complete resource limits with hard ceilings, one-way cancellation with race protection, and bounded, secret-scrubbed output. Sandbox tools ride the Step 5 Tool System (`sandbox.execute` is high risk → forced human confirmation); there is no unrestricted execution endpoint. `security/sandbox-mock` (`@veltravia/sandbox-mock`) is the deterministic offline mock runtime — it executes NO host code and claims NO OS-level isolation; a production container/microVM runtime implements the same interface later (see [docs/sandbox.md](docs/sandbox.md)). Step 9 adds the **Coding Agent**: `coding-agent/core` (`@veltravia/coding-agent-core`) — the file-and-validation specialization of the agent loop. Coding runs are bounded and state-machine-driven: a validated plan that a HUMAN approves before any mutation, decisions that are validated (the model cannot invent tools), file mutations and validations that flow ONLY through the Tool System (deleting a file and sandbox execution are high risk → forced human confirmations), revision discipline (must read or create before update/delete; stale revisions fail typed; the run's sandbox id is never taken from decisions), file content treated as UNTRUSTED DATA (prompt injection gains no authority), secret rejection on every coding input surface, server-side limits with hard ceilings, one-way cancellation, and scrubbed audit. `coding-agent/mock` (`@veltravia/coding-agent-mock`) provides deterministic offline scripted decision sources and a full fixture environment; the API exposes safe run/inspect/cancel/confirmation endpoints (`/api/coding/runs…`) that return only normalized run views — no file contents, no secrets, no chain-of-thought (see [docs/coding-agent.md](docs/coding-agent.md)). Step 10 adds the **first real connector and `invoke_tool`**: `connectors/github` (`@veltravia/connector-github`) — scoped GitHub source control (an explicit `owner/repository@branch` list enforced on every operation), hardened path/branch/sha validation, revision-protected writes, typed scrubbed errors, and an HTTPS-only production transport whose token is read per request and never retained; plus a deterministic offline fake transport so the whole suite runs keyless. The coding agent's optional `invoke_tool` action is allowlist-gated (trusted server-side config only), re-passes the full Tool System pipeline, forces human confirmation for high-risk tools, and replays tool results as UNTRUSTED DATA (see [docs/connectors.md](docs/connectors.md) and [docs/security.md](docs/security.md)). Step 11A adds the **web UI foundation**: a token-based design system (typography, spacing, radius, shadows, borders, restrained motion), a reusable accessible component library (buttons, fields, switches, badges, cards, tooltips, dialogs, menus, tabs, toasts, empty/error states, and more), a light/dark/system theme architecture driven by `data-theme` + CSS custom properties, and a responsive application shell (collapsible sidebar, top bar with account menu, mobile drawer navigation) routing Dashboard / Projects / Settings to clearly-marked placeholder pages — no fabricated functionality (see [docs/ui.md](docs/ui.md)). Step 11B adds the **first real web feature surface**: a typed fetch client (`apps/web/src/api/`) that validates every response and maps it to a safe view model (engine-internal fields never reach React state), and the **Dashboard / Projects / Project detail** pages — project creation (server-assigned ownership), revision-safe editing (409 conflicts are surfaced, never silently overwritten), confirmation-gated archive/restore, status filtering, workspace overview + creation, and honest loading/empty/error states throughout, all backed by the real Project Engine API. Step 11C-1 adds the **AI workspace shell**: a per-project workspace page (`#/projects/<id>/workspace`) with a project context panel, AI conversation surface and composer, and agent/tool activity panels — a responsive three-region layout (side panels become accessible drawers on mobile) with an explicit trust visual language for message origins. It is a visual shell only: nothing calls an AI, tool, sandbox, or connector API, submitted text stays local, the file tree is a labeled illustration, and no functionality is fabricated (see [docs/ui.md](docs/ui.md)). Step 11C-2 wires that workspace to the EXISTING Agent API: submitting the composer creates a real agent run (`POST /api/agents/run` with `{ agentId, task, projectId }`), run statuses map to explicit UI phases, non-terminal states are followed with bounded polling, cancellation flows through the real cancel endpoint and is claimed only on server confirmation, and a completed run's `finalOutput` renders as the assistant message — never a fabricated response, with honest failed/cancelled/limit states and new-run retry. One active run per conversation, generation-guarded against stale responses; the browser remains a pure presentation client (no provider SDKs, endpoints, credentials, or environment reads in web source — test-enforced) (see [docs/ui.md](docs/ui.md) and [docs/security.md](docs/security.md)). Step 11C-3 adds **human confirmations and tool activity to the workspace**: a paused run's pending confirmation becomes an approve/reject card that renders only server-reported metadata (tool id, risk level, state — never the requested input), the decision travels to the real confirmation endpoint, and the Tool System — never the browser — validates expiry, input binding, and permissions before executing or skipping the tool; the activity panel lists recorded tool invocations and the pending confirmation in backend order with tool output treated as bounded UNTRUSTED DATA, every run phase maps to one honest entry, an expired confirmation is terminal in the UI, at most one decision is in flight per run, and a failed delivery keeps the run at its last server-confirmed state with an honest note and a single resync (see [docs/ui.md](docs/ui.md) and [docs/security.md](docs/security.md))). Step 11C-4 gives the workspace **real project context**: run requests carry `projectId` + the selected `workspaceId`, the association is validated server-side against the Project Engine (unknown ids → 404, a foreign workspace → 400, no unchecked association), and the API derives a bounded safe context — project/workspace metadata plus a STRUCTURE-ONLY file tree (paths + types, honest truncation flags, never file contents) — delivered as an explicit `project_context` UNTRUSTED DATA block that is never concatenated into the trusted system prompt. The context panel becomes live (real project metadata, a workspace picker, and the workspace's actual read-only file tree), and the web source never calls file-content endpoints nor mutates files (test-enforced) (see [docs/ui.md](docs/ui.md) and [docs/security.md](docs/security.md)). Step 11C-5 closes the workspace phase with a polish + regression-hardening pass: broken font-weight token references fixed, stale pre-11C-3 copy removed, the conversation becomes a polite `role="log"` live region (announced, never focus-stealing), client-side create failures leave an honest unique system note, the run-status strip aligns with the conversation column, long paths/tool output wrap instead of overflowing, the workspace header becomes a proper `<h2>`, and dead CSS is removed — presentation-only, with no new capability and no trust-boundary change.

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
9. **Real connectors** — vendor integrations (source control, databases, storage, payments) behind the same interface
10. **Self-development** — propose → test → review → deploy pipeline, behind approval gates (`security/`)
