# Veltravia AI

Veltravia AI is an advanced AI software-development platform. Its long-term goal is a system that can build web and mobile applications, backend systems and APIs, generate and modify code, test and debug projects, connect to multiple AI providers and external services, maintain project memory, and improve itself through a controlled, reviewed self-development process.

**Current development stage: Step 1 — Foundation.**
This repository currently contains the project structure, tooling, CI pipeline, and documentation only. No AI, connector, or execution functionality is implemented yet — those belong to later development steps (see [docs/architecture.md](docs/architecture.md)).

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
├── ai/             # Future AI orchestration (intentionally empty in Step 1)
├── connectors/     # Future external-service connector system
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

## Testing

Tests use **Vitest**:

- Unit tests live next to the code they test (`packages/*/src/*.test.ts`, `apps/*/src/**/*.test.ts`).
- Cross-workspace integration tests live in [`tests/`](tests/) — for example, the API health test exercises the real Fastify app and verifies the monorepo wiring end to end.
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
- Connector credentials are isolated from generated project code.

## Future architecture overview

Veltravia AI will evolve step by step (details in [docs/architecture.md](docs/architecture.md)):

1. **Foundation** _(this step)_ — monorepo, tooling, CI, security documentation
2. **Core AI** — provider-agnostic AI router (`ai/`), prompts, agents
3. **Project engine** — isolated workspaces, filesystem abstraction, sandboxed execution (`project-engine/`)
4. **Connectors** — external-service integrations with credential isolation (`connectors/`)
5. **Self-development** — propose → test → review → deploy pipeline, behind approval gates (`security/`)
