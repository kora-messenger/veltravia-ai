# Veltravia AI

Veltravia AI is an advanced AI software-development platform. Its long-term goal is a system that can build web and mobile applications, backend systems and APIs, generate and modify code, test and debug projects, connect to multiple AI providers and external services, maintain project memory, and improve itself through a controlled, reviewed self-development process.

**Current development stage: Step 5 — Tool/Function System.**
Steps 1–4 are complete: the monorepo foundation, the provider-neutral **AI Core** (`ai/core`) with its mock provider, the **Gemini adapter** (`ai/providers/gemini`, the only code importing the Gemini SDK), and the **connector framework** (`connectors/core` + `connectors/mock`). Step 5 adds the **tool system**: `tools/core` (`@veltravia/tool-core`) — strongly typed tool definitions with input/output schemas, a validated registry, a permission-gated manager (registration grants nothing), a human-confirmation flow (single-use, input-bound, expiring; high/critical risk always requires it), runtime availability, a controlled invocation pipeline (exists → available → input valid → permissions → connector authorization → confirmation → execute → output validation), typed scrubbed errors, and audit events — plus `tools/mock` (`@veltravia/tool-mock`), deterministic offline proof tools, and read-only API endpoints (`GET /api/tools`). Connector-backed tools authorize through the ConnectorManager and can never bypass it; their external execution is deliberately not enabled yet, and no AI agent exists yet (see [docs/architecture.md](docs/architecture.md) and [docs/tools.md](docs/tools.md)).

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
├── project-engine/ # Future isolated workspace/execution engine
├── security/       # Future security modules (policy, sandboxing, secrets)
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
6. **AI agent layer** — orchestration that decides when and why to use tools
7. **Project engine** — isolated workspaces, filesystem abstraction, sandboxed execution (`project-engine/`)
8. **Real connectors** — vendor integrations (source control, databases, storage, payments) behind the same interface
9. **Self-development** — propose → test → review → deploy pipeline, behind approval gates (`security/`)
