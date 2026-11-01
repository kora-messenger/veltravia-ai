# App Builder architecture (Step 30)

Veltravia's App Builder is the foundation for turning a described application into a real
project in the stack the user asked for. This document covers what exists, what is only
declared, and how to extend it. It deliberately does not claim working execution for a
language whose registry entry merely exists.

## 1. What this step is, and is not

**Built in Step 30**

- A language-independent capability registry (`LanguageFrameworkRegistry`) with the full
  requested matrix: 18 languages and 18 frameworks across web, backend, mobile, systems,
  data, smart contracts and shell.
- Strict project specification validation with a separate capability answer.
- Evidence-weighted technology stack detection from file names and manifest text.
- Deterministic scaffold generation for a curated subset, driven by registry data.
- An owner-scoped builder manager that materializes plans through the existing project
  engine and hands coding work to the existing coding agent.
- One API surface and one web surface (`#/builder`).

**Not built in Step 30**

- No language is `executable`: no build or test is run, because nothing in this repo can
  compile arbitrary toolchains. The registry says `planned` or `scaffold`, and the page
  repeats that verbatim.
- No deployment happens. Deployment targets are declarations.
- No preview is started by the builder; the runtime engine (Step 17) owns that lifecycle.
- No mobile client exists in this repo. The API is the shared surface a mobile client
  would use; the web app is the only implemented client.

## 2. Packages and responsibilities

| Location                                           | Responsibility                                                                                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app-builder/core` (`@veltravia/app-builder-core`) | Types, errors, capability registry, catalog data, specification validation, stack detection, scaffold templates and planning, ports, owner-scoped manager. No storage, no execution, no network. |
| `apps/api/src/app-builder-service.ts`              | Adapters: implements the builder's ports over the real `ProjectEngine` and coding agent.                                                                                                         |
| `apps/api/src/routes/app-builder.ts`               | HTTP surface under `/api/app-builder`.                                                                                                                                                           |
| `apps/web/src/api/app-builder.ts`                  | Browser client.                                                                                                                                                                                  |
| `apps/web/src/pages/BuilderPage.tsx`               | `#/builder` workspace.                                                                                                                                                                           |

The builder duplicates none of the following; it calls them:

- **Project engine (Step 7)** - projects, workspaces, files, revisions.
- **Sandbox (Step 8)** and **runtime (Step 17)** - execution and preview lifecycles.
- **Coding agent (Step 9)** - file-level implementation runs.
- **AI router (Step 28)** and **provider gateway (Step 26)** - model choice and calls.
- **Version control (Step 18)**, **codebase intelligence (Step 16)**, **testing (Step 15)**.

## 3. Project specification

A specification is data. `validateProjectSpecification` answers two separate questions.

```json
{
  "name": "Ledger service",
  "description": "Records invoices and exports monthly totals.",
  "projectKind": "backend",
  "frontend": "react",
  "backend": "node-fastify",
  "database": { "engine": "postgresql", "migrations": true },
  "authentication": { "strategy": "passkeys", "providers": [] },
  "apis": [{ "name": "Invoices", "protocol": "rest", "access": "private" }],
  "dependencies": ["zod@3.23.8"],
  "build": { "outputDirectory": "dist", "environmentVariables": [] },
  "runtime": { "port": 3000 },
  "environment": ["DATABASE_URL"],
  "deployment": { "target": "container", "provider": "fly" }
}
```

Question 1 - **is it well formed?** Structure, types, bounded text, safe relative paths,
no secret-shaped values, no unknown fields, and cross-field coherence (a mobile framework
only in a mobile project, a backend where the kind requires one, an app-store target only
for mobile). Every problem comes back as an issue with a `path`, a stable `code` and a
plain message.

Question 2 - **can the platform act on it?** The review reports the resolved stack, the
weakest support level across the stack (`executable` > `scaffold` > `planned`), and each
technology it cannot act on with a reason. Validation never fails because a technology is
only declared; planning does, and says which one.

`compareRequestedStack` exists for the other direction: given a detection result and a
requested specification it reports conflicts, so a spec can never silently overwrite the
stack that is actually in a project.

## 4. Technology registry

One entry per language or framework. Nothing in the builder branches on a specific
technology; behaviour is read from these fields.

| Field                         | Meaning                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `id`, `name`                  | Stable id and display name.                                                             |
| `kind`                        | `language` or `framework`.                                                              |
| `layer`                       | `frontend`, `backend`, `mobile`, `systems`, `data`, `smart-contract`, `shell`, `other`. |
| `versions`                    | Versions the entry claims to describe.                                                  |
| `packageManagers`             | `id`, `command`, `manifest`, `lockfile`, `supportsInstall`.                             |
| `build`, `test`               | `argv` (no shell string), description, `maxSeconds`.                                    |
| `runtime`                     | Required runtimes, compiled flag, minimum memory.                                       |
| `preview`                     | Mode (`static`, `server`, `device-emulator`, `none`), ports, note.                      |
| `deployment`                  | Target ids and a note.                                                                  |
| `unsupported`                 | What this entry explicitly cannot do.                                                   |
| `supportLevel`                | `executable`, `scaffold` or `planned`.                                                  |
| `extensions`, `manifestFiles` | Detection signals (languages).                                                          |
| `languageId`                  | Parent language (frameworks).                                                           |
| `scaffold`                    | Starter template id, if any.                                                            |

Validation on registration rejects duplicate ids, framework entries whose language is not
registered, non-version version strings, non-argv commands (a shell string, `sh`, `bash`,
`-c`, `&&`, `;`, `|`, `$(`, backticks), unsafe ports, and secret-shaped material.

**Adding a technology** is one entry plus, optionally, one template: `registry.register()`
with a `LanguageEntry` or `FrameworkEntry` in `app-builder/core/src/registry/catalog.ts`.
No builder code changes. Tests in `registry.test.ts` cover the invariants a new entry must
satisfy; run them before shipping an entry.

## 5. Stack detection

`detectTechnologyStack(manifest, registry)` takes paths and optional text and returns
projects, languages, frameworks, unknown languages and notes.

- Signals are weighted: an exact manifest file (`go.mod`, `pubspec.yaml`, `pom.xml`,
  `Cargo.toml`, `composer.json`, `*.csproj`, `Package.swift`, `CMakeLists.txt`, ...) counts
  more than a file extension; a declared dependency in a manifest body counts more still.
- Confidence is evidence divided by a fixed weight, clamped to 1. Nothing is "detected"
  from a single stray extension with the same confidence as a full project.
- Files whose extensions belong to a language the registry does not carry are reported by
  extension (`Lua`, `Zig`, ...) rather than mapped to a language that only looks similar.
- The detector never reads the filesystem. The API builds the manifest from the project
  engine, so detection sees exactly the files the caller is allowed to see.

## 6. Generation

`buildScaffoldPlan` is pure: specification plus registry in, files and commands out.

- It refuses - `APP_BUILDER_UNSUPPORTED_TECHNOLOGY` - when any role in the resolved stack is
  `planned`, and names the technology. It never substitutes a language the user did not
  choose, and it never produces a stub labelled as if it were the chosen stack.
- Templates exist for HTML/CSS/JS, JavaScript, TypeScript, React (Vite), Node/Fastify,
  Python, Go and Dart/Flutter. Each is a pure function of the specification.
- Every plan carries the build and test commands **declared by the registry**, the preview
  capability, and the honest note that this release does not run them.

## 7. Orchestration and the two experiences

`AppBuilderManager` owns no storage and no execution. Ports:

| Port                            | Provided by     | Used for                                                                           |
| ------------------------------- | --------------- | ---------------------------------------------------------------------------------- |
| `ProjectFilesPort`              | project engine  | create the project/workspace, directories and files, list paths, read bounded text |
| `CodingAgentPort`               | coding agent    | hand implementation work to the existing bounded agent                             |
| `SandboxPort`                   | sandbox manager | `available: false` in this release                                                 |
| `PreviewPort`, `DeploymentPort` | -               | `available: false` with the reason                                                 |

Ownership: every plan and every run is stored with an `ownerRef`. A plan belonging to
someone else answers exactly like a missing one (`APP_BUILDER_PLAN_NOT_FOUND`), because
existence itself is owner-private. Materialization creates the project with the caller's
`ownerRef`, so the project engine's own rules then apply.

**Web experience** - `#/builder`: describe the project, validate, detect, plan, materialize,
and read the registry with its real support levels.

**Mobile experience** - the API is the contract: capabilities, registry, validation,
detection, plans, materialization and coding handoff are all ordinary JSON endpoints with
owner scoping, so a mobile client shares accounts, projects, permissions and backend
services without a second implementation. Responsive editing, build progress and approval
screens are the same endpoints the existing approval flows already expose. No mobile client
ships in this repository yet; the boundaries are tested (`api-app-builder.test.ts`) rather
than claimed.

## 8. Security boundaries

See `docs/security.md` §5w. In short: registry commands are argv arrays validated at
registration, never shell strings; detection reads names only; materialization writes only
relative, traversal-free paths through the project engine; every endpoint is owner-scoped;
provider credentials never appear in a builder response; build, preview and deployment
remain unavailable rather than approximated.

## 9. Milestones

1. **Step 30 (done)** - registry, specification, detection, scaffolds, orchestration,
   API and web surface.
2. **Real execution** - give the sandbox a real container runtime, then promote a language
   from `scaffold` to `executable` only when its build and test commands actually run green
   inside it.
3. **Assistant-driven planning** - route specification generation and plan critique through
   the reasoning engine, with the validator as the final authority.
4. **Dependency installation** - sandboxed package-manager installs with a lockfile diff and
   an explicit approval per install.
5. **Deployment providers** - start with static hosting, then containers; a deployment is a
   human-approved operation, never automatic.
6. **Mobile client** - a Flutter or React Native shell over the same endpoints, starting with
   project list, coding conversation, approvals and build status.
