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

## Current state: Step 2 — AI Core

The foundation (Step 1) is complete: monorepo, tooling, CI, security documentation. Step 2 adds the **AI Core** (`ai/core`, workspace `@veltravia/ai-core`): provider-neutral types, the `AIProvider` interface, the `ModelRegistry`, a deterministic `AIRouter`, the normalized error system, configuration handling, and a `POST /api/ai/generate` endpoint wired to a **mock provider** (`ai/providers/mock`). Real provider adapters (Gemini, OpenAI, Anthropic, …) are deliberately NOT connected yet — the architecture they will plug into is what this step builds. `connectors/`, `project-engine/`, `agents/`, and `prompts/` remain intentionally empty of code.

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

| Directory                | Responsibility                                                                                                             | Status                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `ai/core/`               | The provider-neutral AI Core: types, provider interface, model registry, deterministic router, typed errors, configuration | **Implemented (Step 2)** |
| `ai/providers/mock/`     | Deterministic, offline, keyless mock provider used by tests and the API                                                    | **Implemented (Step 2)** |
| `ai/providers/<vendor>/` | One adapter per real provider (Gemini, OpenAI, Anthropic, …), each its own workspace                                       | Future                   |
| `ai/agents/`             | Agent definitions (planner, builder, reviewer, debugger) composed on `ai/core`                                             | Future                   |
| `ai/prompts/`            | Versioned prompt templates, reviewed and tested like code                                                                  | Future                   |

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

#### Streaming (planned, not implemented)

Streaming will be added WITHOUT replacing the provider interface:

- The base `AIProvider` stays `send(request, model): Promise<AIResponse>` — non-streaming providers never change.
- A future `AIChunk` type (content delta + request id + optional final usage) joins `types/`.
- Adapters that support streaming expose an optional `sendStream(request, model): AsyncIterable<AIChunk>`; a type-guard/interface extension marks streaming providers.
- `streaming` is already a capability in the registry, so the router can filter for it; `AICore` will gain a `generateStream()` facade that reuses the same routing and error paths and aggregates chunks into the same `AIResponse` shape.

Because responses are normalized and capability-driven, nothing built in Step 2 has to be rewritten when streaming lands.

### `connectors/` — external-service integration (future)

| Directory               | Future responsibility                                                                                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connectors/core/`      | The connector interface, lifecycle (connect/refresh/revoke), and **credential isolation**: connector credentials are held by the core and never handed to generated project code or the AI prompt stream. |
| `connectors/providers/` | Individual connectors (Slack, GitHub, Google, …), each its own package.                                                                                                                                   |

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

| Step                       | Scope                       | What gets built                                                                                                                           |
| -------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Foundation** _(done)_ | Structure, tooling, CI      | Monorepo, lint/test/build, CI, security documentation                                                                                     |
| **2. Core AI** _(current)_ | `ai/core`, mock, `apps/api` | Provider-neutral types, `AIProvider` interface, model registry, capability system, deterministic router, typed errors, `/api/ai/generate` |
| 2b. Real providers         | `ai/providers/*`            | First vendor adapters (Gemini/OpenAI/Anthropic) behind the same interface, secrets via the secret manager                                 |
| 2. Core AI                 | `ai/*` workspaces           | Provider router + adapters, prompt versioning, first agents                                                                               |
| 3. Project engine          | `project-engine/*`          | Isolated workspaces, sandboxed execution                                                                                                  |
| 4. Connectors              | `connectors/*`              | Connector interface + first providers, credential isolation                                                                               |
| 5. Persistence & auth      | `apps/api`, packages        | Database, authentication, multi-user state                                                                                                |
| 6. Self-development        | `ai/`, `security/`          | Propose → test → review → deploy loop, behind human-approval gates                                                                        |
| 7. Production              | deployment                  | Real deployment target (cloud), monitoring, staging                                                                                       |

Later steps add their own dependencies only when they become necessary — this is a standing rule, not a Step 1 rule.

## Design rules

1. **Dependency-free downward.** `packages/types` imports nothing. `shared` and `config` import nothing beyond Node built-ins. Apps may import packages; packages never import apps.
2. **One way to do each thing.** One lint config, one test runner, one env accessor, one result type.
3. **Everything through CI.** No code merges without lint, tests, and a passing build — including future AI-generated changes (the self-development pipeline targets this same CI).
4. **Prompts and agent definitions are code.** They are versioned, reviewed, and tested like any other source file.
5. **Security is structural, not procedural.** Sandboxing and credential isolation are enforced by module boundaries (`project-engine/execution`, `connectors/core`), not by convention.
