# Backend deployment & staging (Step 37)

What this document covers: how the API is deployed, what it requires from a host,
what survives a restart, and what cannot be done without an account or domain
that nobody has supplied yet.

**Status at the time of writing: the deployment layer is implemented and tested.
No service has been deployed.** Section 9 says exactly what is missing.

---

## 1. What the API actually needs from a host

Measured from the code, not assumed:

| Requirement       | Reality                                                                 | Consequence for hosting                                                     |
| ----------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Node.js           | 20+ (`node:fs/promises`, native `fetch`, `structuredClone`)             | Any modern runtime; the repo targets Node 20 in CI                          |
| Process model     | One Fastify process, in-memory services                                 | One instance is enough; anything multi-instance shares no state             |
| CPU / memory      | Light: no model runs locally, no ffmpeg, no OCR in the API process      | The smallest paid instance tier is adequate                                 |
| Streaming         | Server-sent events on `/api/reasoning/.../events` and `/api/ai/execute` | The host must not buffer responses or cap request duration at a few seconds |
| Long requests     | A coding run can hold a request for tens of seconds                     | Idle timeouts must be generous (60s+), not a 10s gateway default            |
| Durable state     | None by default; file collections when configured                       | Needs a disk that survives restarts, or state is lost (section 4)           |
| File storage      | In memory, by design (Step 19)                                          | A restart drops uploaded files; no object storage is wired                  |
| Sandbox execution | Simulated, never executed                                               | No container, no privileged runtime, no nested virtualisation               |
| Network egress    | Outbound HTTPS to AI providers only                                     | No inbound tunnel, no private network, no fixed egress IP needed            |
| WebSockets        | Not used                                                                | A host without WebSocket support is still fine                              |

The honest summary: this is an ordinary small HTTP service. Nothing about it needs
Kubernetes, a message queue or a managed AI platform.

## 2. Architecture

```
  Android APK ─┐
               ├─ HTTPS ─► reverse proxy (TLS) ─► Fastify API ─┬─► AI providers (HTTPS)
  Web app ─────┘                                              ├─► durable file collections
                                                              └─► in-memory services
```

Deployment-neutral by construction:

- **One entry point.** `apps/api/src/main.ts` resolves configuration, refuses an
  unsafe one, then listens. There is no vendor SDK in the API.
- **The host is described, not imported.** `API_HOST`, `API_PORT`,
  `VELTRAVIA_PUBLIC_API_URL` and `NODE_ENV` are the whole contract with a platform.
- **Storage is a port.** `VELTRAVIA_STORAGE_DRIVER` selects memory or file; a
  database adapter later implements the same four gateway ports without touching
  the gateway, the routes or the UI.
- **Nothing assumes localhost.** Good for a laptop, a container or a VM alike.

## 3. Environment variables

Everything is in `.env.example`. The ones that matter:

| Variable                       | Required       | Purpose                                                                        |
| ------------------------------ | -------------- | ------------------------------------------------------------------------------ |
| `NODE_ENV`                     | yes            | `development`, `test`, `staging`, `production`. Selects how strict startup is. |
| `API_HOST` / `API_PORT`        | no             | Bind address; defaults `0.0.0.0:3000`.                                         |
| `VELTRAVIA_PUBLIC_API_URL`     | remote         | The API's own https address. Clients and the APK use it.                       |
| `VELTRAVIA_CORS_ORIGINS`       | remote         | Comma-separated exact web origins. Never `*`.                                  |
| `VELTRAVIA_CREDENTIAL_KEY`     | remote         | 32-byte base64 key that encrypts provider credentials.                         |
| `VELTRAVIA_STORAGE_DRIVER`     | no             | `memory` (default) or `file`.                                                  |
| `VELTRAVIA_DATA_DIR`           | with `file`    | Directory for the collections. Must be writable and persistent.                |
| `VELTRAVIA_TRUST_PROXY`        | behind a proxy | Whether `X-Forwarded-For` may be believed.                                     |
| `VELTRAVIA_BODY_LIMIT_BYTES`   | no             | Request ceiling, default 40 MB.                                                |
| `VELTRAVIA_REQUEST_TIMEOUT_MS` | no             | Default 30s.                                                                   |
| `VELTRAVIA_SHUTDOWN_GRACE_MS`  | no             | Drain window on SIGTERM, default 10s.                                          |
| `VELTRAVIA_LOG_LEVEL`          | no             | Structured pino level, default `info`.                                         |

Provider keys (`OPENROUTER_API_KEY*`, `OPENAI_API_KEY`, `GROQ_API_KEY`,
`MISTRAL_API_KEY`) are read server-side by the gateway's startup seed and stored
encrypted. They are never returned by an API and never reach a client.

### Startup refuses rather than degrades

In `staging` and `production`, `assertDeploymentConfig` exits with code 78 and a
readable list of problems when any of these is true:

- `VELTRAVIA_PUBLIC_API_URL` is missing, not a URL, not https, or points at localhost;
- `VELTRAVIA_CORS_ORIGINS` is empty or contains `*`;
- a CORS origin is not https;
- `VELTRAVIA_CREDENTIAL_KEY` is missing (no provider key could ever be stored);
- `VELTRAVIA_STORAGE_DRIVER=file` with no `VELTRAVIA_DATA_DIR`.

In `development` the same findings are warnings, because a laptop has no TLS and
no domain. That asymmetry is the point: the strictness follows the environment.

## 4. Persistence: what survives a restart

Audited by hand. `memory` is the default everywhere, which is what the test suite
and local work depend on.

| Data                                            | Default | With `VELTRAVIA_STORAGE_DRIVER=file` |
| ----------------------------------------------- | ------- | ------------------------------------ |
| Provider credentials (encrypted)                | lost    | **kept**                             |
| Provider connections                            | lost    | **kept**                             |
| Provider preferences                            | lost    | **kept**                             |
| Usage records                                   | lost    | **kept** (capped at 5,000)           |
| Agent profile (custom agent name)               | lost    | lost                                 |
| Projects, workspaces, file trees                | lost    | lost                                 |
| Uploaded files & artifacts                      | lost    | lost                                 |
| Reasoning / coding runs, revisions, checkpoints | lost    | lost                                 |
| Tool activity, audits, jobs                     | lost    | lost                                 |

The four gateway collections are the ones worth keeping: they are the credentials
someone re-enters by hand and the usage history that cannot be recreated. They
live in `<VELTRAVIA_DATA_DIR>/*.json`, written to a temporary file and renamed, so
a crash mid-write cannot leave a half file. Each write is serialised, files are
mode `0600`, and a file that cannot be parsed is never overwritten: the process
reports the collection as unusable instead of starting empty over recoverable data.

**Not persistent, stated plainly:** projects, workspaces, project files, uploads,
analyses and run history all disappear on restart. That is a known limitation of
this milestone, not an oversight. Making them durable needs a database (section 5),
because a JSON file rewritten on every keystroke of a coding run is the wrong tool.

## 5. Database: not adopted yet, on purpose

The ports exist (`VaultRecordStore`, `ConnectionStore`, `PreferenceStore`,
`UsageStore`) and the file adapter implements them, so a SQL adapter is an
additive change. It is not adopted in this milestone because:

- every service that would use it is in-memory today, so a database would hold
  almost nothing while adding a dependency, migrations and a connection pool to
  every deployment;
- the project engine's file trees, revisions and checkpoints need a schema design
  of their own, which is a milestone, not a task.

`DATABASE_URL` and `AUTH_*` in `.env.example` are placeholders for that step.
Nothing reads them yet; do not deploy expecting a database.

## 6. Secret management

- No `.env` file is committed. `scripts/` and CI read only from the environment.
- Startup validates presence, never prints a value; `/health` and `/ready` report
  `credential-encryption: ok` and never the key.
- The gateway's vault stores AES-256-GCM ciphertext with a versioned key, so
  rotation is additive: set `VELTRAVIA_CREDENTIAL_KEYS=new,old`, re-save the
  connections, then drop the old key.
- Logs run through pino `redact` on every credential-shaped path, including
  `authorization`, `cookie`, `apiKey`, `password`, `token`, `credentialRef`,
  at the root and one level deep. Tests assert a marker replaces the value and
  that harmless neighbouring fields survive.
- The APK carries no secret: it reads a `runtime-config.json` at run time and
  holds only a public API URL.

## 7. Network security

- **CORS:** exact-origin allowlist. A credentialed call is answered only for a
  named origin; an unlisted origin gets `403` and no allow header; `*` in a
  request is treated as just another unlisted origin. No reflection.
- **TLS:** required in staging and production (a non-https public URL is refused
  at startup), with HSTS added to successful responses. Certificate verification
  is never disabled.
- **Forwarded headers:** believed only when `VELTRAVIA_TRUST_PROXY=true`, because
  an untrusted `X-Forwarded-For` is an identity spoof.
- **Limits:** 40 MB body cap, 30s request timeout, 10s connection timeout.
- **Responses:** `nosniff`, `referrer-policy: no-referrer`, `x-frame-options: DENY`;
  `cache-control: no-store` on credential, reasoning and run paths.
- **Errors:** a 5xx answers `{code, message, requestId}` and nothing else. The
  stack, the message and the underlying error go to the log, keyed by that id.
  A 4xx keeps its own message, which is written for a person.

## 8. Health, readiness, shutdown

`GET /health` is liveness: process alive, version, mode, uptime. It touches no
dependency, so a wedged instance can be restarted without waiting.

`GET /ready` is readiness: `configuration` (no startup problems),
`credential-encryption`, `storage` (only when a data directory is configured, and
only when it can be written) and any extra dependency the deployment adds. Any
failure answers **503** with `status: "not-ready"`. A check reports a verdict and
a sentence; it never contains a path, a value or a hostname.

`SIGTERM`/`SIGINT` stop accepting connections and let in-flight requests finish
inside the grace window, then exit 0. A stuck request cannot hang a deploy: the
window expires and the process exits 1, and a second signal exits immediately.

## 9. Deployment: recommended host, and what is missing

Requirements from section 1 rule out a few obvious options:

| Option                                              | Verdict                                                                                                                                                                                            |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Render / Railway style PaaS, free tier**          | Web service only, no persistent disk on free, and the instance sleeps after idle. Sleeping breaks the readiness gate and loses the file collections. Acceptable for a smoke test, not for staging. |
| **Serverless (Lambda, Vercel, Cloudflare Workers)** | Request-duration caps and buffered responses fight the SSE streams; Workers has no Node filesystem. Wrong shape for this API.                                                                      |
| **Managed container platform (Cloud Run / ECS)**    | Works, but a disk is not durable without mounting a volume, and the setup is heavier than this milestone needs.                                                                                    |
| **Small VM (1 vCPU, 1 GB) with Docker + Caddy**     | Full control, a real disk, no request caps, predictable cost, TLS by Caddy in one file. Manual hardening is the price.                                                                             |
| **Fly.io machine with a volume**                    | Container, a real volume, SSE-friendly, `fly deploy` from CI, pay-as-you-go at a few dollars a month. Least work per unit of reliability.                                                          |

**Recommendation: Fly.io**, one small machine with one volume mounted at
`VELTRAVIA_DATA_DIR`, behind its TLS proxy.

Why this one: the API needs a durable disk, unbounded streaming responses and a
long request timeout, and nothing else. Fly gives exactly those three with a
volume, no request buffering and no duration cap; the deploy hook drops cleanly
into `deploy-api.yml`; and the cost is a single small machine rather than a
platform with a per-service minimum. A VM with Caddy is the fallback if the
account cannot be created; it is more work for the same result.

**No account, token or domain has been supplied, so nothing has been deployed.**
Creating a paid resource was out of scope. The exact manual steps:

1. Create a Fly.io organisation (owner action, billing required for a machine).
2. `fly launch --no-deploy` from `apps/api`, choosing a region near the users.
3. `fly volumes create veltravia_data --size 1` and mount it at `/data`.
4. Set `VELTRAVIA_DATA_DIR=/data`, `VELTRAVIA_STORAGE_DRIVER=file`,
   `NODE_ENV=staging`, `VELTRAVIA_PUBLIC_API_URL=https://<app>.fly.dev`,
   `VELTRAVIA_CORS_ORIGINS=<the web app origin>` with `fly secrets set`.
5. Set `VELTRAVIA_CREDENTIAL_KEY` (32-byte base64) with `fly secrets set`.
6. Add `DEPLOY_HOOK_URL` and `VELTRAVIA_PUBLIC_API_URL` as secrets on the
   `staging` GitHub environment, and a required reviewer on that environment.
7. Run the **Deploy API** workflow with `target=staging`, `confirm=DEPLOY` from
   `main`. It fails unless `/ready` answers within five minutes.

The same steps with `production` and a `v*` tag for the production environment.

### Staging account

No developer backdoor and no hardcoded test account exist, and none was added. To
create a staging account safely: create it through the normal client flow with a
strong unique password stored in a password manager, keep it out of the
repository, and delete it when staging is retired. The API has no user account
system of its own yet (ownership is expressed with an owner reference header that
the client sends), so "an account" today means a client-side owner reference.

## 10. APK and web API URL

- The web app calls the API on its own origin by default and can be pointed
  elsewhere with `VELTRAVIA_API_PROXY_TARGET` in development.
- The Android build reads `runtime-config.json` at run time, so one APK can point
  at any environment without a rebuild, and no URL is baked into the bundle.
- A release build with no configured URL shows an explicit configuration notice
  and does not pretend to be connected. That behaviour is unchanged by this step
  and is covered by its existing tests.
- To point the APK at the deployed API, set the repository variable
  **`VELTRAVIA_API_BASE_URL`** (Settings → Secrets and variables → Actions →
  Variables) to `VELTRAVIA_PUBLIC_API_URL`. It is a variable, not a secret: an
  API address is public information, and only variables are readable by the APK
  build. With it unset, `android.yml` prints a warning and still builds, so the
  APK arrives in its honest "not configured" state.
- The API URL is public information. No credential, key or secret is included in
  the APK assets.

## 11. GitHub Actions

`ci.yml` (unchanged) lints, tests and builds on every push and pull request.

`deploy-api.yml` is new and deliberately strict:

- `workflow_dispatch` only, with an explicit `confirm=DEPLOY` input;
- staging only from `main`, production only from a `v*` tag;
- binds to a GitHub environment, so reviewers and secrets are configured there,
  not in the file;
- re-runs lint, tests and build before deploying;
- **reports "nothing was deployed" and stops** when the environment has no deploy
  hook, instead of going green on a deploy that never happened;
- after triggering the hook, polls `/ready` for up to five minutes and fails if
  the service never becomes ready.

A skipped job stays grey. Nothing in this repository can make an undeployed run
look successful.

## 12. Tests added in this step

`apps/api/src/deployment/*.test.ts` (46 tests) cover: config resolution in every
mode, missing and malformed variables, the wildcard refusal, https and localhost
rules, secret-presence-without-value, CORS allow and refuse and preflight,
unlisted-origin 403, uncacheable sensitive responses, 5xx without a stack,
4xx keeping its message, 404 shape, the body limit, forwarded-header trust,
streamed bodies passing through untouched, durable stores across a new instance,
a corrupt file never being overwritten, an unwritable collection failing
readiness, redaction at depth, and shutdown both clean and timed out.

## 13. Known limitations

1. Nothing is deployed. The provider choice is a recommendation, not a fact.
2. Projects, workspaces, files, uploads and run history are still per-process.
3. No database adapter. `DATABASE_URL` is a placeholder.
4. Single instance only: the file collections do not coordinate between processes.
5. The API has no authentication of its own; ownership is a client-supplied
   reference, so staging must not be exposed to the open internet without a
   review of that boundary.
6. Uploaded files are in memory, so a restart during an analysis loses them.
7. Usage records are capped at 5,000 per file, oldest dropped first.
