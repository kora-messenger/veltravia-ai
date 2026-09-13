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

## Current state: Step 1 — Foundation

Only the foundation exists today: the monorepo layout, build/lint/test tooling, the CI pipeline, two minimal applications (`apps/web`, `apps/api`), three shared packages, and security documentation. The `ai/`, `connectors/`, `project-engine/`, and `security/` trees are **intentionally empty of code** — each contains only a README describing its future responsibility. This is deliberate: empty directories add no dependencies and make no premature technical commitments, while reserving the structure the platform will grow into.

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

### `ai/` — AI orchestration (future)

| Directory       | Future responsibility                                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai/core/`      | The provider-agnostic AI router: request dispatch, retries, timeouts, token/cost budgets, and the circuit breaker that prevents one dead provider from stalling the platform. |
| `ai/providers/` | One adapter per provider (OpenAI, Anthropic, Google, OpenRouter, …) implementing a shared interface, so the core never talks to a vendor SDK directly.                        |
| `ai/agents/`    | Higher-level agent definitions (planner, builder, reviewer, debugger) that compose prompts and tool calls into workflows.                                                     |
| `ai/prompts/`   | Versioned prompt templates. Prompts are treated as code: reviewed, tested, and shipped through the same CI.                                                                   |

These will become npm workspaces (`ai/*` added to the root `workspaces` array) when Step 2 (Core AI) begins. See the no-verbatim/copyright rule below.

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

| Step                          | Scope                  | What gets built                                                    |
| ----------------------------- | ---------------------- | ------------------------------------------------------------------ |
| **1. Foundation** _(current)_ | Structure, tooling, CI | Monorepo, lint/test/build, CI, security documentation              |
| 2. Core AI                    | `ai/*` workspaces      | Provider router + adapters, prompt versioning, first agents        |
| 3. Project engine             | `project-engine/*`     | Isolated workspaces, sandboxed execution                           |
| 4. Connectors                 | `connectors/*`         | Connector interface + first providers, credential isolation        |
| 5. Persistence & auth         | `apps/api`, packages   | Database, authentication, multi-user state                         |
| 6. Self-development           | `ai/`, `security/`     | Propose → test → review → deploy loop, behind human-approval gates |
| 7. Production                 | deployment             | Real deployment target (cloud), monitoring, staging                |

Later steps add their own dependencies only when they become necessary — this is a standing rule, not a Step 1 rule.

## Design rules

1. **Dependency-free downward.** `packages/types` imports nothing. `shared` and `config` import nothing beyond Node built-ins. Apps may import packages; packages never import apps.
2. **One way to do each thing.** One lint config, one test runner, one env accessor, one result type.
3. **Everything through CI.** No code merges without lint, tests, and a passing build — including future AI-generated changes (the self-development pipeline targets this same CI).
4. **Prompts and agent definitions are code.** They are versioned, reviewed, and tested like any other source file.
5. **Security is structural, not procedural.** Sandboxing and credential isolation are enforced by module boundaries (`project-engine/execution`, `connectors/core`), not by convention.
