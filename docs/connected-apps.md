# Connected Apps (Step 24)

Read-only intelligence over third-party apps the owner explicitly connects.
`connected-apps/core` holds the provider architecture, connection lifecycle,
resource access, provenance and the intelligence bridge;
`connected-apps/mock` provides deterministic offline providers.

Nothing in this step writes to a third-party app. There is no tool, route or
adapter that creates, edits or deletes remote content.

## What is real and what is simulated

| Layer                                               | Status                                                   |
| --------------------------------------------------- | -------------------------------------------------------- |
| Connection lifecycle, scope enforcement, provenance | Real                                                     |
| Rate budgets, timeouts, size caps, redaction        | Real                                                     |
| GitHub provider (transport, path/repo allowlisting) | Real connector, live when a token and allowlist are set  |
| Google Drive and Notion providers                   | Deterministic simulation - no vendor API is implemented  |
| Document Intelligence bridge (`/analysis`)          | Real parsers over connected bytes; summary is an extract |

The API reports the active mode per provider (`live` or `mock`) so the UI never
implies a real account where a simulation runs. `CONNECTED_APPS_GITHUB_TOKEN`
plus `CONNECTED_APPS_GITHUB_REPOS` switches GitHub to live mode; without them
the deterministic GitHub provider runs.

The summary returned by `/analysis` is a bounded extract of the parsed
structure tagged `structure_extract`. No language model is called, and the tag
says so rather than implying generated prose.

## Connection model

- A connection is owned by exactly one owner reference. Every read resolves the
  connection through that owner; a foreign owner gets `404`, never data.
- Connecting is explicit: the owner chooses scopes from the provider's declared
  list. Unknown scopes fail with `CONNECTED_INSUFFICIENT_SCOPE`.
- Granting a scope does not imply a capability. Capabilities are derived from
  granted scopes and checked per call.
- Disconnecting is terminal and immediate; subsequent reads return
  `CONNECTED_NOT_CONNECTED`.
- Credentials live in a `CredentialVault`. Only a reference crosses the manager
  boundary, and no API response contains a token, refresh token or credential
  reference.

## Providers

| Provider     | Capabilities                                 | Scopes                                              |
| ------------ | -------------------------------------------- | --------------------------------------------------- |
| GitHub       | list repositories, read files, read issues   | `repositories:read`, `contents:read`, `issues:read` |
| Google Drive | list files, read file content, read metadata | `drive.metadata.readonly`, `drive.readonly`         |
| Notion       | list pages and databases, read page content  | `pages:read`                                        |

All providers are read-only. GitHub additionally enforces an owner/repository
allowlist on every operation, rejects unsafe paths, and requires HTTPS.

## Provenance and trust

Every resource, content read and analysis result carries provenance: provider,
account, resource id and name, source URL where available, retrieval time and
revision. The trust model is unchanged from earlier steps:

| Data                            | Trust tag           |
| ------------------------------- | ------------------- |
| Resource listings and metadata  | `untrusted_data`    |
| Resource content (files, pages) | `untrusted_data`    |
| Structured analysis summary     | `structure_extract` |

Connected content is never authorization. A note inside a connected document
cannot grant a capability, approve a plan or change a connection.

## Tools

Ten read-only tools are registered under `connections.*`: list accounts, list
resources, search, read metadata, read content, read issue, analyze document,
summarize, compare resources, and provider health. Each tool declares the
capability it needs, so the Tool System can grant or withhold it independently
of the connection itself.

Tool output drops null fields: an absent field means "unknown or unavailable"
rather than a nullable union, which keeps the declared output schema honest.

## API

| Method   | Path                                                  | Purpose                       |
| -------- | ----------------------------------------------------- | ----------------------------- |
| `GET`    | `/api/connections`                                    | Providers, connections, modes |
| `GET`    | `/api/connections/:providerId`                        | Connection + health           |
| `POST`   | `/api/connections/:providerId/session`                | Session description           |
| `POST`   | `/api/connections/:providerId/complete`               | Connect with chosen scopes    |
| `DELETE` | `/api/connections/:providerId`                        | Disconnect                    |
| `GET`    | `/api/connections/:providerId/health`                 | Provider health               |
| `GET`    | `/api/connections/:providerId/resources`              | List resources (cursor paged) |
| `GET`    | `/api/connections/:providerId/search?q=`              | Search                        |
| `GET`    | `/api/connections/:providerId/resources/:id/metadata` | Resource metadata             |
| `GET`    | `/api/connections/:providerId/resources/:id/content`  | Bounded text content          |
| `GET`    | `/api/connections/:providerId/resources/:id/analysis` | Parse and summarize           |

`/session` returns `authorization.kind: "simulated"` with a plain explanation.
This build has no OAuth app registration, so the UI completes a simulated
authorization instead of pretending to redirect.

## Web

`#/connections` shows provider cards with the honest mode, granted scopes,
account and health, a connect dialog where the owner picks scopes, and a
resource browser with a provenance panel and a bounded content view. Empty,
error, disconnected and binary-resource states are explicit.

## Known limitations

- Google Drive and Notion are simulations; no real vendor API is wired.
- GitHub live mode requires an operator-supplied token and repository allowlist.
- No OAuth redirect flow: sessions are simulated and stated as such.
- Analysis summaries are extracts, not model-generated prose.
- No write, comment or upload operation exists in this step.
