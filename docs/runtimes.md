# Preview & App Runtime (Step 17)

> Package: `runtime/core` (`@veltravia/runtime-core`) ·
> `runtime/mock` (`@veltravia/runtime-mock`) · API surface:
> `apps/api/src/runtime-service.ts` + `apps/api/src/routes/runtimes.ts` ·
> Web surface: `apps/web/src/api/runtimes.ts` +
> `apps/web/src/pages/projects/PreviewPanel.tsx`

Step 17 gives Veltravia a preview/app runtime layer: a validated,
evidence-based plan → build → start → health-check → serve lifecycle for
generated apps, with revision binding, expiry, bounded logs, and a
platform-controlled preview URL.

## What exists in this step

- **Plan detection (`detection`)** — a `RuntimePlan` is DERIVED from
  workspace evidence (manifest scripts, frameworks, present files,
  codebase index), never assembled by hand. Active runtime types: `web`
  and `fullstack`. `backend` and `mobile-preview` are declared but
  honestly unsupported (`RUNTIME_TYPE_UNSUPPORTED`).
- **Validation (`plan`)** — structured commands only (allowlisted
  executables, no shell metacharacters, no path-like binaries), bounded
  limits with hard ceilings (nothing unlimited), health checks bounded,
  secret-shaped environment keys AND values rejected
  (`RUNTIME_ENV_REJECTED`).
- **State machine (`state`)** — `created → preparing → building →
starting → running → stopping → stopped`, with `failed` reachable from
  every live phase, one-way `cancelled`, and `expired` (idle + lifetime
  deadlines; a sweep expires stale runtimes).
- **Manager (`manager`)** — the ONLY caller of the executor seam.
  Revision binding (a runtime is pinned to the workspace revision it was
  created from; advancing the workspace marks it `stale`, start rejects
  with `RUNTIME_REVISION_MISMATCH`, restart rebuilds at the LATEST
  revision and stops the old runtime), staleness is always reported
  honestly and never silently rebased, idle activity refreshes expiry,
  hard ceilings (active runtimes globally + per workspace), bounded
  scrubbed audit events.
- **Executor seam (`executor`)** — `build`, `start`, `stop`, `health`,
  `isHosting`, `previewContent`. The API server is NEVER the runtime: all
  execution flows through this isolation boundary.
- **Mock executor (`runtime/mock`)** — a deterministic offline executor
  with a full failure matrix (`ok`, `build-failure`,
  `missing-dependency`, `start-failure`, `port-conflict`,
  `health-failure`, `resource-limit`, `flaky-then-healthy`). It is
  labeled `simulated` everywhere and provides NO OS-level isolation; its
  preview page says SIMULATED. A production executor (container /
  microVM / dedicated worker) implements the same interface later —
  nothing else changes.
- **Failure model** — failures are structured reports (`kind`, `phase`,
  `message`): `build_failed`, `missing_dependency`, `start_failed`,
  `port_conflict`, `health_failed`, `start_timeout`,
  `resource_exhausted`. No silent 500s, no "unknown error" placeholders.
- **Logs (`logs`)** — bounded byte-budget + entry-count log buffer with
  scrubbing (control characters stripped, credential-shaped output
  redacted, oversized lines truncated with an honest marker). Runtime
  logs are UNTRUSTED DISPLAY DATA, never executed.
- **Memory candidates (`memory-candidates`)** — runtime facts flow into
  project memory as NON-AUTHORITATIVE `candidate` records under the
  Step 15 human-approval rules; the simulated-isolation limitation is
  itself a candidate so it is never forgotten.

## API surface

Every route is project-scoped; ownership is resolved server-side
through the Project Engine gateway:

| Route                                                               | Purpose                                                                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `POST /api/projects/:projectId/runtimes`                            | create a runtime (plan detected; strict schema: only `workspaceId`, `runtimeType`, `scenario` accepted) |
| `GET /api/projects/:projectId/runtimes`                             | list (newest first, optional `workspaceId` filter)                                                      |
| `GET /api/projects/:projectId/runtimes/:id`                         | view (typed 404 for unknown/foreign runtimes)                                                           |
| `GET /api/projects/:projectId/runtimes/:id/logs`                    | bounded log snapshot                                                                                    |
| `POST .../start` `.../stop` `.../cancel` `.../restart` `.../expire` | lifecycle intents (browser sends only the id)                                                           |
| `GET .../health`                                                    | one bounded health probe                                                                                |
| `GET /preview/:runtimeId`                                           | the platform-controlled preview page (sandboxing headers; executor decides content)                     |

Error mapping: `RUNTIME_INVALID_REQUEST` 400 · `RUNTIME_PLAN_REJECTED` /
`RUNTIME_ENV_REJECTED` / `RUNTIME_TYPE_UNSUPPORTED` 422 ·
`RUNTIME_NOT_FOUND` 404 · `RUNTIME_REVISION_MISMATCH` /
`RUNTIME_INVALID_TRANSITION` 409 · `RUNTIME_EXPIRED` 410 ·
`RUNTIME_LIMIT_EXCEEDED` 429.

## Web surface

The Project Detail page gains a **Preview** section (`PreviewPanel`):
pick a workspace, create/start/stop/restart a preview, see the honest
status + plan + structured failure, and view bounded logs. While a
runtime is live, a bounded 5s slow-follow refreshes the view (max 60
ticks). The preview frame points at the platform-controlled
`/preview/:runtimeId` URL through the same-origin dev proxy.

The browser NEVER sends commands, ports, limits, or environment values —
the strict API schema rejects them with a 400, and the plan is always
detected server-side.

## Honest limitations (this release)

- The shipped executor is the **simulated mock**: the platform builds
  and serves nothing. Every surface (API views, UI copy, preview page)
  labels this honestly; the limitation is also recorded as a project
  memory candidate.
- Framework inference today covers the Vite web + React/Vite/Fastify
  fullstack templates (matching the Step 13 generation engine); other
  stacks fail with an honest `RUNTIME_PLAN_REJECTED` rather than a
  wrong plan.
- Health checks in the mock are scripted per scenario, not real network
  probes.

## Testing

- `runtime/core` + `runtime/mock`: unit suites (state machine, plan/env/
  limits validation, detection matrix, log scrubbing/bounding, manager
  lifecycle/revision/expiry/audit, mock honesty + preview safety).
- `apps/api`: HTTP tests over the full scenario matrix + strict-schema
  rejections + preview sandboxing + boundary tests (source scans: no
  child_process/fs in runtime source, manager is the only executor
  caller).
- `apps/web`: component tests for the panel (create/start/stop/restart,
  honest failure render, logs, boundaries).
