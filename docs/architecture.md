# Veltravia AI — Architecture

## Overview

Veltravia AI is an advanced AI software-development platform. The end state is a system that can:

- build web applications, mobile applications, and backend systems/APIs
- generate and modify code
- test and debug projects
- connect to multiple AI providers
- connect to external services through a connector system
- maintain project memory
- run development tools in controlled environments
- create new capabilities for itself through a controlled self-development system
- propose, test, review, and eventually deploy approved improvements

The project is built **incrementally**. This document describes the target structure, the purpose of each part, and how the system is expected to evolve.

## Current state: Step 7 — Project & Workspace Engine

Step 7 adds the **Project & Workspace Engine**: the provider-neutral, infrastructure-neutral state layer for projects, workspaces, and virtual file trees.

- `project-engine/core` (`@veltravia/project-core`): `Project` / `Workspace` / `FileNode` models with validated lifecycle transitions (soft delete is terminal; illegal transitions throw), repository interfaces (identity + revision + storage owned by repositories; rules owned by managers — a future DB adapter implements the same interfaces), hardened path security (traversal / absolute / Windows / null-byte / control-character rejection, typed errors that never echo raw input), full file-tree operations with parent/duplicate/type/subtree rules, optimistic revision protection on EVERY mutation (`expectedRevision` mismatches are rejected, never overwritten), structured project context and configuration (secret-like keys AND secret-shaped values rejected at validation time), credential-free integration references, and deterministic secret-free snapshots (metadata only — file contents never leave the engine through snapshots).
- `project-engine/mock` (`@veltravia/project-mock`): deterministic, offline, keyless in-memory repositories plus engine assembly — the whole test suite runs without network, tokens, or keys.
- `apps/api` gained a strict project/workspace/file surface: `POST|GET /api/projects`, `GET|PATCH /api/projects/:id`, `POST …/archive`, `POST …/restore`, `POST|GET /api/projects/:id/workspaces`, `GET /api/workspaces/:id`, `GET …/tree`, `GET …/files/*`, `POST …/files`, `PATCH|DELETE …/files/*`, `POST|DELETE …/directories`, `POST …/nodes/move`, `POST …/nodes/rename` — strict schemas (unknown fields → 400), typed errors → correct status codes (404/409/400), secrets → scrubbed `SECRET_REJECTED`. NOT exposed: host filesystem, shell, execution, connectors, GitHub. See [project-engine.md](project-engine.md).

The engine is PURE STATE MANAGEMENT and deliberately stops there: no sandbox, no execution, no coding agent, no GitHub, no concrete databases. File contents, context, configuration, and metadata are PROJECT DATA — never instructions. The agent layer was NOT modified; project TOOLS for the agent are a future step.

## Step 6 recap — AI Agent Layer

Step 6 added the **AI agent layer**: the provider-neutral orchestration that decides when and why to use tools.

- `agent/core` (`@veltravia/agent-core`): the `Agent` abstraction with a controlled execution method; `AgentRequest` (task, optional session/project/user ids, optional tool filter, caller limits, plain metadata — never secrets) and `AgentResponse` (completed / awaiting_tool / awaiting_confirmation / failed / cancelled / limit_reached — safe normalized data, never chain-of-thought); `AgentState` with a controlled state machine (idle → planning → waiting_for_tool / waiting_for_confirmation / executing → terminal; terminal statuses never transition again — a cancelled run never resumes); the `DefaultAgent` loop (validate request → bounded iterations → decide via a `DecisionSource` → parse + validate the `AgentDecision` → dispatch tool requests THROUGH the Tool System → record normalized results → terminate or pause on confirmations); `AgentExecutionLimits` (safe defaults + hard ceilings — there is no unlimited); cancellation (one-way flag, audited, never auto-resumed); an `AgentRegistry` (duplicate ids rejected) and an `AgentManager` (create/get/continue/confirm/cancel/list — no background workers, no job queues); `ModelDecisionSource` bridging AI Core (Agent → AI Core → AI Router → AI Provider — no vendor SDKs anywhere in Agent Core); trust-tagged context where tool results are UNTRUSTED DATA; and scrubbed agent audit events.
- `agent/mock` (`@veltravia/agent-mock`): deterministic, offline, credential-free scripted agents (`ScriptedDecisionSource`, `createMockAgent`) that drive the REAL loop for tests and CI — including deliberately malformed decisions.
- `apps/api` gained safe agent endpoints: `POST /api/agents/run`, `GET /api/agents/runs/:runId`, `POST /api/agents/runs/:runId/cancel`, `POST /api/agents/runs/:runId/confirmation`, `GET /api/agents` — no secrets, no chain-of-thought, no unlimited limits, no self-approval. See [agents.md](agents.md).

Everything from Steps 1–5 is unchanged and still green (Step 5 recap below). The agent is a GENERAL ORCHESTRATOR — not a coding agent, not a project engine, not self-development: it cannot create files, run code, modify its implementation, approve its own confirmations, or exceed its limits. Connector-backed tool execution beyond authorization remains deliberately disabled (the Step 5 boundary).

## Step 5 recap — Tool/Function System

Step 5 added the **tool system**: the controlled layer between AI orchestration and actions.

- `tools/core` (`@veltravia/tool-core`): `ToolDefinition` (id, input/output schemas, permissions, risk level, optional connector reference), provider-neutral schema validation (rejects missing fields, wrong types, malformed and unexpected input — problem messages name fields, never values), the `ToolRegistry` (validated registration, duplicate rejection), the `ToolManager` (registration grants NOTHING; explicit, auditable permission grants; runtime availability; human confirmation decisions), `ToolInvocation`/`ToolInvocationResult` (a request is never permission to execute), and the `ToolExecutor` — the gated pipeline: exists → available → input valid → permissions → connector authorization → confirmation → execute → output validation → normalized result. Plus typed scrubbed errors and tool audit events.
- `tools/mock` (`@veltravia/tool-mock`): deterministic, offline, credential-free proof tools — an executable summarizer (input validation + normalized results), a critical-risk purge tool (risk-forced confirmation), and a connector-backed reference tool (Tool → ConnectorManager → Connector).
- `apps/api` gained read-only endpoints (`GET /api/tools`, `GET /api/tools/:id`) exposing safe metadata only — no execution endpoint exists.

Steps 1–4 were unchanged and stayed green: the AI Core (`ai/core`), the mock provider, the Gemini adapter (`ai/providers/gemini`), and the connector framework (`connectors/core`, `connectors/mock`). Connector-backed tools authorize through the ConnectorManager and can never bypass it — and their external execution is deliberately not enabled yet (the pipeline stops at a typed "not enabled" failure). The AI agent layer (Step 6) now decides when and why to use tools. See [tools.md](tools.md) and [agents.md](agents.md).

## Repository structure

### `apps/` — deployable applications

| Directory   | Purpose                                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/` | The Veltravia AI web application (Vite + React). Today: a minimal shell. Later: the dashboard/IDE where users interact with the platform.                                               |
| `apps/api/` | The backend API service (Fastify). Today: a health endpoint. Later: the public API that fronts all AI, connector, and project-engine capabilities, plus authentication and persistence. |

Applications are the only things that get deployed. Everything else is a library.

### `packages/` — shared libraries (npm workspaces)

| Directory          | Purpose                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/types/`  | Dependency-free shared TypeScript domain types (`HealthCheckResponse`, `Environment`, etc.). Anything needed by both web and API belongs here.                                                         |
| `packages/shared/` | Framework-agnostic utilities with no Node/browser-specific dependencies. Currently: the `Result<T, E>` pattern for explicit error handling and small helpers.                                          |
| `packages/config/` | Environment-variable reading and validation (`readEnv`, `requireEnv`, `readIntEnv`). One canonical way to access configuration; no dotenv dependency (Node 20 loads `.env` natively via `--env-file`). |

New shared libraries (e.g. `packages/logger`, `packages/database`) slot in as new workspaces.

### `ai/` — AI orchestration

| Directory               | Responsibility                                                                                                                              | Status                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `ai/core/`              | The provider-neutral AI Core: types, provider interface, model registry, deterministic router, typed errors, configuration                  | **Implemented (Step 2)** |
| `ai/providers/mock/`    | Deterministic, offline, keyless mock provider used by tests and the API                                                                     | **Implemented (Step 2)** |
| `ai/providers/gemini/`  | The Google Gemini adapter: the ONLY code importing `@google/genai`; Interactions API mapping, error normalization, retry-policy abstraction | **Implemented (Step 3)** |
| `ai/providers/<other>/` | One adapter per additional real provider (OpenAI, Anthropic, …), each its own workspace                                                     | Future                   |
| `agent/core/`           | The provider-neutral agent layer: Agent interface, state machine, controlled loop, decisions, limits, cancellation, audit                   | **Implemented (Step 6)** |
| `agent/mock/`           | Deterministic, offline scripted agents driving the real loop for tests/CI                                                                   | **Implemented (Step 6)** |
| `project-engine/core/`  | The provider-neutral Project & Workspace Engine: models, path security, repositories, managers, snapshots                                   | **Implemented (Step 7)** |
| `project-engine/mock/`  | Deterministic in-memory repositories behind the same interfaces a future DB adapter implements                                              | **Implemented (Step 7)** |
| `ai/agents/`            | Future specialized agent definitions (planner, builder, reviewer, debugger) composed on `agent/core`                                        | Future                   |
| `ai/prompts/`           | Versioned prompt templates, reviewed and tested like code                                                                                   | Future                   |

#### AI Core design (Step 2)

**Why provider-neutral?** If application code talked to vendor SDKs directly, Veltravia AI would be structurally dependent on one AI company — pricing changes, outages, or deprecations anywhere in the codebase would force rewrites. The core instead defines Veltravia's OWN request/response vocabulary (`AIRequest` / `AIResponse`), a single `AIProvider` interface, and a registry of models with declared capabilities. Vendor formats exist only inside future adapter packages. Adding a provider = writing one adapter + registering its models; nothing else changes.

**Request flow:** `AICore.generate(request)` → strict validation (`validateAIRequest`, with configured limits) → `AIRouter.select` → provider `send(request, model)` → normalized `AIResponse`.

**Registry:** `ModelRegistry` is the single source of truth: which models exist, which provider owns them, what capabilities they declare, and whether they are available. Routing decisions read only registry data — never vendor catalogues or hard-coded lists.

**Capability system:** `AICapability` is a closed union (text-generation, structured-output, streaming, vision, image-generation, tool-calling, embeddings, audio-input, audio-output, large-context, code-generation). Models declare capabilities at registration; the router checks `required ⊆ declared` BEFORE routing, so the platform can always answer "can this model perform this task?" without guessing.

**Router (deterministic, Step 2 scope):** 1) explicit `request.model`, 2) configured default model, 3) first registered, available, enabled model declaring all required capabilities (default-provider tiebreak). No scoring or heuristics yet — those arrive with real providers. No match → typed error.

**Errors:** one normalized error hierarchy (`AIError` base with stable `code`s: `AI_INVALID_REQUEST`, `AI_MODEL_NOT_FOUND`, `AI_CAPABILITY_NOT_SUPPORTED`, `AI_PROVIDER_NOT_FOUND`, `AI_PROVIDER_ERROR`, `AI_CONFIGURATION_ERROR`). Provider adapters must convert vendor errors into these classes; `AICore` additionally wraps any non-AI error a provider throws into `AIProviderError`. Vendor error shapes never reach application code.

**Configuration:** `loadAIConfig()` reads only routing and limit variables (default model/provider, enabled providers, message/character limits, timeout) from the environment via `@veltravia/config`. Secrets are absent by design — future adapters will bind keys from the secret manager at runtime. `requestTimeoutMs` is carried but enforced starting with the first real adapter.

**API integration:** `apps/api` exposes `POST /api/ai/generate` with a Fastify-validated client contract that is deliberately NOT the internal `AIRequest` shape. The API layer maps the body to the core request, maps `AIError.code`s to HTTP statuses (400/404/422/502/503/500), and returns `{ error: { code, message } }` on failure — no stack traces, no internals, no secrets. See `docs/security.md` §3a for the AI Core's hard restrictions (no shell, no filesystem, no generated-code execution).

**Mock provider (`ai/providers/mock`):** implements the same interface, returns deterministic content built from the input, predictable usage numbers, stable request ids, and a fixed (or injected) clock. It needs no network and no API key, so the entire core — registry, router, errors, and the live API endpoint — is testable offline.

#### Gemini adapter (Step 3)

`ai/providers/gemini` (workspace `@veltravia/ai-provider-gemini`) connects Google Gemini through the **Interactions API** — Google's current recommended interface (`interactions.create`), GA since June 2026. The legacy `generateContent` API is intentionally not used.

**Isolation.** The adapter is the ONLY place in the platform that imports `@google/genai`. The AI Core, the router, the API route, and the web app see only the `AIProvider` interface and normalized types. If Google replaced their entire SDK tomorrow, only this one package would change.

**Request mapping** (`src/mapping.ts`): `user` messages → `user_input` steps, `assistant` → `model_output` steps; `request.system` plus `system`-role messages merge into `system_instruction`; structured output → `response_format` (`type: "text"`, `mime_type: "application/json"`, schema); `temperature`/`maxOutputTokens` → `generation_config`. The adapter sends the full history each request (stateless), so Veltravia never depends on Gemini's server-side conversation state.

**Response mapping**: `model_output` text content → `AIResponse.content`; `usage.total_input_tokens/total_output_tokens/total_tokens` → `AIUsage` (missing fields stay `undefined` — nothing is fabricated); interaction status → normalized finish reason (`completed` → `stop`, `incomplete`/`budget_exceeded` → `length`, `failed`/`cancelled` → `error`); interaction id → `requestId`.

**Configuration** (`src/config.ts`): `GEMINI_API_KEY` (server-only), `GEMINI_MODEL` (default `gemini-3.8-flash`), `GEMINI_REQUEST_TIMEOUT_MS`, `GEMINI_ENABLED`, `GEMINI_STORE_INTERACTIONS`, `GEMINI_THINKING_LEVEL`. The key is read in exactly one place and handed to the SDK client at construction; it is never logged, returned, or committed.

**Registered models**: `gemini-3.8-flash` (default — Google's current Flash flagship, built for long-horizon software engineering) and `gemini-3.1-pro-preview` (SOTA reasoning/coding), both declaring `text-generation`, `code-generation`, and `structured-output`. The default model id is configuration, not code.

**Error normalization** (`src/errors.ts`): every failure — SDK `ApiError` (400 → invalid request, 401/403 → configuration, 404 → model not found, 429 → rate limited, 5xx → unavailable), timeouts, network faults, malformed responses — becomes a typed `AIError` with a `retryable` flag and a scrubbed message. The API key substring is redacted from every message and detail before it can surface anywhere.

**Retry policy** (`src/retry.ts`): an abstraction, not a loop — Step 3 performs NO automatic retries (`NoRetryPolicy`), while every error already carries `retryable`/`retryAfterMs` data so a future backoff/circuit-breaker policy (the reference `ConservativeRetryPolicy` is included but not wired in) can be adopted without touching the provider.

**Future stateful conversations**: Gemini's `previous_interaction_id` is a documented, optional hook in the mapping layer (read from model metadata); the provider-neutral `AIRequest` deliberately has NO Gemini conversation concept, so providers with different conversation mechanisms remain first-class citizens.

#### Streaming (planned, not implemented)

Streaming will be added WITHOUT replacing the provider interface:

- The base `AIProvider` stays `send(request, model): Promise<AIResponse>` — non-streaming providers never change.
- A future `AIChunk` type (content delta + request id + optional final usage) joins `types/`.
- Adapters that support streaming expose an optional `sendStream(request, model): AsyncIterable<AIChunk>`; a type-guard/interface extension marks streaming providers.
- `streaming` is already a capability in the registry, so the router can filter for it; `AICore` will gain a `generateStream()` facade that reuses the same routing and error paths and aggregates chunks into the same `AIResponse` shape.

Because responses are normalized and capability-driven, nothing built in Step 2 has to be rewritten when streaming lands.

### `connectors/` — external-service integration (Step 4: core + mock implemented)

| Directory               | Responsibility                                                                                                                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connectors/core/`      | **Implemented.** The provider-neutral `Connector` interface, metadata/categories/capabilities, the permission system, credential **references** (never values), operation declarations, registry, manager, typed errors, audit events. |
| `connectors/mock/`      | **Implemented.** Deterministic, offline, credential-free mock connector that proves the framework (safe for CI).                                                                                                                       |
| `connectors/providers/` | **Future.** Individual vendor connectors (GitHub, databases, storage, payments, …), each its own package implementing only the `Connector` interface.                                                                                  |

Details in [connectors.md](connectors.md).

### `tools/` — the tool & function system (Step 5: core + mock implemented)

| Directory     | Responsibility                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tools/core/` | **Implemented.** Tool definitions, schema validation, registry, manager, permission gating, human confirmation, availability, invocation model, controlled executor, typed errors, audit events. |
| `tools/mock/` | **Implemented.** Deterministic, offline proof tools (executable summarizer, critical-risk confirmation demo, connector-backed reference).                                                        |

Details in [tools.md](tools.md).

### `project-engine/` — isolated execution engine (future)

| Directory                    | Future responsibility                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `project-engine/filesystem/` | Virtual filesystem abstraction over generated projects — the only layer allowed to touch project files, with path-traversal guards.                                                                                      |
| `project-engine/workspace/`  | Workspace and session management: create, snapshot, restore, and clean up project state.                                                                                                                                 |
| `project-engine/execution/`  | Sandboxed command execution (containers or equivalent isolation): resource limits, network policy, no access to host secrets. **The AI never receives unrestricted host access** — this module is the enforcement point. |

### `security/` — security modules (future)

Future home of the platform's enforcement code: the policy engine (approval gates for self-development changes), the sandbox manager, the secrets broker, and the audit log. The security _policy_ is documented today in [security.md](security.md); the code arrives with the features it guards.

### `tests/` — integration tests

Cross-workspace tests that exercise the system end-to-end (e.g. `tests/api-health.test.ts` boots the real API app). Unit tests live next to the code they test.

### `docs/`, `scripts/`, `.github/`

Documentation, developer helper scripts (`scripts/check.sh` mirrors CI locally), and CI pipelines respectively.

## Evolution plan

| Step                                       | Scope                                     | What gets built                                                                                                                                                                                              |
| ------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1. Foundation** _(done)_                 | Structure, tooling, CI                    | Monorepo, lint/test/build, CI, security documentation                                                                                                                                                        |
| **2. Core AI** _(done)_                    | `ai/core`, mock, `apps/api`               | Provider-neutral types, `AIProvider` interface, model registry, capability system, deterministic router, typed errors, `/api/ai/generate`                                                                    |
| **3. Gemini provider** _(done)_            | `ai/providers/gemini`                     | First real adapter: Interactions API (the current official Gemini interface), error normalization, retry-policy abstraction, live-test harness                                                               |
| **4. Connector architecture** _(done)_     | `connectors/core`, `mock`                 | Provider-neutral connector interface, metadata, capabilities, permission system, credential references, operation declarations, registry, manager, typed errors, audit events, read-only API                 |
| **5. Tool/Function System** _(done)_       | `tools/core`, `mock`                      | Tool definitions, schema validation, registry, manager, permission gating, human confirmation (single-use, input-bound, expiring), availability, controlled invocation pipeline, audit events, read-only API |
| **6. AI agent layer** _(done)_             | `agent/core`, `mock`, `apps/api`          | Controlled orchestration: bounded loops, validated decisions, tool requests through the Tool System, human confirmations, cancellation, safe run/confirmation API                                            |
| **7. Project & Workspace Engine** _(done)_ | `project-engine/core`, `mock`, `apps/api` | Projects, workspaces, virtual file trees, path security, revision protection, context/config, integration references, snapshots, strict API                                                                  |
| 7. Project engine                          | `project-engine/*`                        | Isolated workspaces, filesystem abstraction, sandboxed execution                                                                                                                                             |
| 8. Real connectors                         | `connectors/providers/*`                  | First vendor connectors (source control, databases, storage, payments) behind the same interface                                                                                                             |
| 9. Persistence & auth                      | `apps/api`, packages                      | Database, authentication, multi-user state                                                                                                                                                                   |
| 10. Self-development                       | `ai/`, `security/`                        | Propose → test → review → deploy loop, behind human-approval gates                                                                                                                                           |
| 11. Production                             | deployment                                | Real deployment target (cloud), monitoring, staging                                                                                                                                                          |

Later steps add their own dependencies only when they become necessary — this is a standing rule, not a Step 1 rule.

## Design rules

1. **Dependency-free downward.** `packages/types` imports nothing. `shared` and `config` import nothing beyond Node built-ins. Apps may import packages; packages never import apps.
2. **One way to do each thing.** One lint config, one test runner, one env accessor, one result type.
3. **Everything through CI.** No code merges without lint, tests, and a passing build — including future AI-generated changes (the self-development pipeline targets this same CI).
4. **Prompts and agent definitions are code.** They are versioned, reviewed, and tested like any other source file.
5. **Security is structural, not procedural.** Sandboxing and credential isolation are enforced by module boundaries (`project-engine/execution`, `connectors/core`), not by convention.
