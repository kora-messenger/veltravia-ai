# Backend Builder (Step 33)

`#/projects/<id>/backend` describes an existing backend from the project's own files, and
hands any change to the coding agent that already exists. It is a reading surface with a
conversation attached: there is no second generation engine, no second storage, and no
write path of its own.

## What it shows

| Section        | Source of the data                                                                    | Honest limit                                               |
| -------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Overview       | stack detection + scan counts                                                         | reports what was read, not what "should" be there          |
| Routes         | declaration parsing (`express/v4/v5`, Fastify, Next app/pages, FastAPI/Flask, Django) | a route with no visible guard is `unknown`, never `public` |
| Database       | manifest + schema files                                                               | `connection: 'not-configured'` - nothing is opened         |
| Models         | Prisma blocks, SQL `CREATE TABLE`                                                     | fields and relations only as declared                      |
| Functions      | serverless entry points and request handlers                                          | described, never invoked                                   |
| Authentication | manifest declarations + in-file guards                                                | `sessionStrategy: 'not-inspected'`                         |
| Environment    | `process.env`, `import.meta.env`, `os.environ` and `.env` templates                   | names only, values discarded                               |
| Logs           | none in this release                                                                  | `available: false` with a plain reason                     |

Every route opens to its **evidence**: the file, the 1-based line, and the declaration
as written. A backend description that cannot be checked is not worth much.

## The AI panel is the coding agent

The right-hand panel is the same `BuilderChatPanel` the frontend builder uses, driven by
the same `useCodingRun` hook. A request becomes a bounded coding run: the run's plan is
shown for approval, nothing is written before that approval, and the files it changed are
reported after it finishes. When the API is running the scripted demo agent, the panel says
so instead of implying a model wrote the plan.

## API

| Method | Path                                           | Returns                            |
| ------ | ---------------------------------------------- | ---------------------------------- |
| `GET`  | `/api/projects/:projectId/backend`             | the whole report                   |
| `GET`  | `/api/projects/:projectId/backend/routes`      | `{ routes, scanned }`              |
| `GET`  | `/api/projects/:projectId/backend/models`      | `{ models, database }`             |
| `GET`  | `/api/projects/:projectId/backend/functions`   | `{ functions }`                    |
| `GET`  | `/api/projects/:projectId/backend/auth`        | `{ auth }`                         |
| `GET`  | `/api/projects/:projectId/backend/environment` | `{ environment }`                  |
| `GET`  | `/api/projects/:projectId/backend/logs`        | `{ logs }`                         |
| `GET`  | `/api/backend/capabilities`                    | what the surface can and cannot do |

All of them accept `?workspaceId=` and default to the project's first active workspace.
Unknown projects, foreign projects and a `workspaceId` that does not belong to the project
all answer `404 SOURCE_REPOSITORY_NOT_FOUND`, so the surface cannot be used to discover which
ids exist. There is no `POST`/`PUT`/`PATCH`/`DELETE` on this surface at all; nothing is
written, executed or connected.

## Reading budget

60 files, 48 KiB each, taken from a priority-ordered candidate list (manifests and schema
files first). Everything past the budget is counted in `scanned.skipped` and, when a read is
cut short, `scanned.truncated` is set and a warning is shown. Empty results are stated as
empty results, not as success.

## What this step does not do

- no database connection, migration, or query
- no function execution
- no log streaming
- no secret values, ever
- no file editing in the panels: changes go through a coding run

## Tests

- `app-builder/core/src/backend/backend.test.ts` - extraction, redaction, empty states
- `apps/api/src/tests/api-backend.test.ts` - ownership, redaction, no write surface, empty project
- `apps/web/src/pages/backend/BackendBuilderPage.test.tsx` - every section, provenance, honest failure
- `apps/web/src/components/brand/brand.test.tsx` - the shipped assets and their wiring
