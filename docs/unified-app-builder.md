# Unified App Builder (Step 34)

One project is one application. Step 34 adds a workspace that shows the frontend, the backend,
the data, the API surface, the files and the assistant as parts of that single application,
rather than as separate tools that happen to know the same project id.

It is a **composition layer**. It owns no store, no analyser and no AI system of its own.

## Architecture

```
apps/web  #/projects/<id>/app  ── UnifiedAppPage (one shell, nine sections)
             │
             ├─ /api/projects/<id>/app            composed view (first paint)
             ├─ /api/projects/<id>/app/{overview,files,links,health}
             ├─ /api/projects/<id>/app/group      POST: path classification only
             ├─ /api/app-builder/unified          capabilities
             └─ existing coding-agent routes      the AI panel and the plan gate
                          │
apps/api  unified-service.ts ── loadUnifiedApp()
             ├─ source layer (@veltravia/source-storage-core)   tree, file reads, history
             ├─ scanBackend()  (@veltravia/app-builder-core)    the Step 33 analyser
             ├─ classifyFrontendStructure()                     the Step 32 classifier
             └─ app-builder/core/src/unified/                   pure derivation
                  ├─ files.ts     logical grouping (reading aid, never a rename)
                  ├─ links.ts     cross-layer graph from file text
                  ├─ health.ts    status vocabulary and reasons
                  └─ overview.ts  project facts and counts
```

Everything the workspace shows is derived in one bounded pass over the same tree, so the
overview, the file explorer and the health panel cannot disagree with each other.

**No duplicates.** There is no second project repository, no second source-storage system and no
second AI execution path. `unified-service.ts` reads through `sourceStorage`, which already
enforces project ownership and resolves the workspace; the AI panel calls the same
`/api/coding/runs` endpoints the frontend and backend builders use.

## Navigation

Nine sections, in one shell with the project identity in the URL (`#/projects/<id>/app`):

| Section          | What it is                                                                |
| ---------------- | ------------------------------------------------------------------------- |
| Overview         | Project facts, measured counts, health, recent changes, honest gaps       |
| Build            | Change review: the agent's plan split into layers, with the approval gate |
| Frontend         | Frontend summary and the Step 32 builder for the same project             |
| Backend          | Backend summary and the Step 33 builder for the same project              |
| Database         | Declared provider, model count, and the fact that nothing connects        |
| API routes       | Declared routes with file:line, callers found, cross-layer connections    |
| Files            | Every file, grouped, read-only, with revisions                            |
| AI assistant     | The coding agent conversation for this project                            |
| Project settings | Read-only identity, workspace and revision facts                          |

Desktop shows a persistent rail. At 760px and below the rail is replaced by a labelled section
picker, so there is no horizontal overflow and no unreachable section. The page never scrolls
sideways at 1440px, 1000px or 390px.

Moving between Frontend and Backend keeps the project because the project id is the URL, not
component state. Switching back restores the same project, workspace and revision.

## Shared project context

The composed view carries:

- project id, name, description, type, status, last update
- workspace id and root revision
- the tree totals and the file grouping
- the same counts the layer pages use (routes, models, frontend sections)

`unified-service.ts` requires project ownership through the source layer before it reads
anything, and additionally checks the project record's `ownerRef`. A foreign project returns
404, exactly like a missing one.

## Frontend integration

`classifyFrontendStructure` (Step 32) runs over the same tree and reports layout, sections and
counts. The Frontend section shows the summary and links to `#/projects/<id>/builder`, which is
the same page as before: no fork, no second copy of the file tree.

## Backend integration

`scanBackend` (Step 33) supplies routes, models, functions, environment **names** and the
database declaration. The Backend section shows counts and links to
`#/projects/<id>/backend`. Both builders write through the coding agent and the project engine,
so a file created in one is visible in the other on the next refresh.

## File explorer

Files are grouped into frontend, backend, shared, configuration, tests, assets and other.

Rules that matter:

- grouping is **path-only** and a reading aid: `groupWorkspaceFiles` returns the project's real
  paths and never renames, moves or hides a file;
- every file lands in exactly one group, so the explorer cannot show fewer files than the
  workspace holds;
- `isBackendSourceFile` from the backend analyser is reused, so grouping cannot drift from what
  the backend builder scans;
- opening a file reads it through the source layer (`/source/file`), which is read-only and
  reports the file revision.

## Cross-layer intelligence

`detectCrossLayerLinks` produces four kinds of edges, each carrying a file and a line at both
ends:

| Edge                                 | Read from                                                         |
| ------------------------------------ | ----------------------------------------------------------------- |
| frontend request → route             | `fetch('/api/...')`, `axios.get('/api/...')`, `/api/...` literals |
| route → handler                      | the route declaration itself                                      |
| handler → model                      | a model name appearing in the route's own file                    |
| route → authentication configuration | a route whose file shows auth wiring                              |

Rules:

- paths match exactly, or segment-by-segment with a declared parameter (`:id`, `[id]`, `{id}`)
  counting as one segment; the confidence says which;
- a request whose path has no route stays in `unmatchedRequests` with a reason
  (`no-matching-route`, `method-mismatch`, `external-host`, `dynamic-url`);
- a route nobody calls is listed as `routesWithoutCaller`, and the payload says in words that
  this is not an error: the caller may live outside the workspace;
- a line that _declares_ a route is never treated as a caller, otherwise every route would look
  invoked by its own declaration;
- a dynamic URL (`/api/users/${id}`) is never guessed into a match.

Unknown relationships stay unknown. The panel prints the counts and the reasons rather than a
percentage or a "healthy" badge.

## AI integration

The assistant is the existing coding agent:

- `POST /api/coding/runs` with the same project and workspace, followed by polling through
  `useCodingRun`;
- plans are the agent's own declaration and are rendered as text, never executed;
- the plan is a hard gate: nothing is written until a human approves, and approval covers exactly
  the files listed;
- tool confirmations still arrive as confirmation cards;
- cancellation is one-way and server-confirmed.

Both the Build and AI assistant sections share one run, so the conversation and the plan are the
same object in both places.

**Capability honesty:** when the API reports `decisionSource: 'scripted-demo'`, the page shows a
"Scripted demo plans" badge and never describes those plans as model-generated.

## Change review

A single request can touch both layers, so `ChangeReview` shows:

- the plan's goal and steps;
- files split into frontend, backend, shared, configuration, tests, assets and other, each marked
  "will be modified" or "will be inspected";
- the run id, state and workspace;
- the approval gate (approve / reject) while the run is `awaiting_approval`.

Classification comes from the server (`POST /app/group`), not from a client-side copy of the
rules, so the review and the explorer agree.

Stale revisions are unchanged from earlier steps: the coding agent reads before it writes and
uses `expectedRevision`, and a conflict surfaces as a typed error on the run, never a silent
overwrite.

## Application health

Six facts, each one of: `configured`, `detected`, `tested`, `running`, `unavailable`,
`not-configured`.

| Fact       | How it is decided                                                                   |
| ---------- | ----------------------------------------------------------------------------------- |
| Frontend   | files classified by the frontend classifier (`detected`) or none (`not-configured`) |
| Backend    | backend files/routes/models read (`detected`) or none (`not-configured`)            |
| API routes | route declarations recognised, with file count                                      |
| Database   | provider declared (`configured`, from a manifest or schema) or nothing declared     |
| Tests      | test files found (`detected`). **Never** `tested`: no test run is recorded          |
| Runtime    | `running` only from a live runtime; otherwise `unavailable` with the reason         |

The panel states that "configured" means a declaration exists, not that anything works, and that
no connection is opened in this release.

## Security boundaries

1. **Ownership** — every read goes through the source layer with the caller's owner ref; a
   foreign project is 404. The project record's owner is checked again before its metadata is
   returned.
2. **Workspace isolation** — one resolved workspace per request; the default is the first active
   workspace, and `?workspaceId=` selects another.
3. **Revision protection** — reads report revisions; writes stay with the coding agent's
   `expectedRevision` discipline.
4. **Approval** — no unified route writes anything. Path grouping is pure classification.
5. **Secret redaction** — environment variables are names only, values never leave the analyser;
   the composed payload is asserted in tests not to contain the seeded secret or DSN.
6. **Server-side authorization** — the browser sends no owner or permission claims.
7. **Tool System** — unchanged: the AI panel reaches files only through the coding agent's tools.
8. **Untrusted project files** — file text is evidence, never instructions; the graph records
   what a line says, it does not act on it.
9. **No code execution** — no shell, no sandbox start from these routes.
10. **No unrestricted filesystem** — reads are bounded (60 UI files, 40 route files, 48 KB each)
    and go through the source layer, never the host disk.

## Current limitations

- No deployment, hosting, database connections, migrations, log streaming or billing.
- The runtime fact stays `unavailable` unless the server supplies a runtime state; the names
  come from the simulated executor.
- Edges cover relative `/api/...` calls. A request built from a config constant, or a route
  mounted under a prefix the file does not spell out, stays unmatched rather than being guessed.
- `handler → model` is a name match inside the route's file, not a query analysis.
- Scans are capped; when a cap is hit the health panel says the picture is partial.
- Health counts come from the file grouping, so "2 frontend file(s)" can only appear when the
  explorer also shows two frontend files. Live QA found the opposite before the fix: a project
  holding only `package.json` and `.env.example` reported two frontend files because the scan
  reads manifests too.
- The assistant is as capable as `codingCaps.decisionSource` says, and the UI shows which.

## Future implementation requirements

- Real deploy/hosting adapters with the same approval gate.
- A database adapter behind the existing `database.connection: 'not-configured'` field.
- Frontend `form → endpoint` detection from component props and action handlers.
- Route prefixes from framework mounting, so a router mounted at `/api` matches `/api/users`.
- Recorded test runs, so `tests` can honestly become `tested`.
- Runtime state wiring into `UnifiedDeps.runtimeState` (the port already exists).
