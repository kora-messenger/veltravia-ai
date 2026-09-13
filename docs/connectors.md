# Veltravia AI — The Connector Framework (Step 4)

## What is a connector?

A **connector** is a controlled integration between Veltravia AI and an external service — a source-control host, a database, object storage, a payment provider, a deployment platform. Connectors are the ONLY sanctioned path from Veltravia AI to the outside world: no component may talk to an external service except through a connector that has been registered, permissioned, and audited.

The connector framework shipped in Step 4 (`connectors/core` + `connectors/mock`) is **infrastructure, not an agent**. It does not decide what the user wants, does not plan tasks, does not call an LLM, does not execute code, and does not touch the network by itself. Operation execution arrives with the Tool/Function System in Step 5.

```
        AI Core
           |
   Tool / Function System          (Step 5 — future)
           |
   Connector Manager               (lifecycle, permission gate, audit)
           |
   Connector Interface             (provider-neutral contract)
           |
  ┌────────┼───────────┐
GitHub  Database  Storage  ...      (future, one package each)
```

## Why the framework is provider-neutral

The core contains no vendor SDKs, no vendor types, and no vendor assumptions. Every connector — GitHub, GitLab, Bitbucket, PostgreSQL, MongoDB, Supabase, Firebase, Cloudflare R2, AWS S3, Stripe, Paystack, Flutterwave, Vercel, Cloudflare, AWS, GCP, and everything after them — implements the SAME `Connector` interface. Adding a vendor therefore means adding a package under `connectors/providers/`; the core never changes to accommodate anyone.

What the core sees is:

- **Metadata** (`ConnectorMetadata`): id, name, version, description, category, capabilities.
- **A permission catalog** the connector DECLARES (what it could do).
- **Operation declarations** (`ConnectorOperation`): what can be requested, and which permissions each request requires.
- **A credential REFERENCE** (optional): metadata-only pointer to a secret.
- **Lifecycle behavior**: `connect`, `disconnect`, `checkHealth`, `getStatus`.

## Credential security (the critical boundary)

The connector core **never stores, transports, or exposes raw API keys, passwords, OAuth tokens, or access tokens**. A `CredentialReference` is structurally incapable of carrying a secret — its only fields are `credentialId`, `credentialType`, `providerRef`, `status`, `createdAt`, `updatedAt`.

```
AI / Connector Manager
        |  holds CredentialReference (metadata only)
        v
Secure Credential Store            <- the ONLY component that holds raw secrets
        |
        v
Actual secret
```

The AI never receives unrestricted raw connector credentials. When a future connector needs its secret to perform an APPROVED operation, the secure store fetches it at execution time — the secret never travels through the connector core, the manager, or any API response.

Defense in depth: registry validation rejects a connector whose credential reference contains secret-like material; the error system scrubs token-shaped strings out of every message and detail; audit events are scrubbed the same way; tests prove all three.

## Permissions

Two layers, deliberately separated:

1. **DECLARED** — the permission catalog a connector publishes (`id`, `description`, `riskLevel`). Declaring is free.
2. **GRANTED** — what the operator has actually allowed, held by the `ConnectorManager`. **Registration grants NOTHING.** Grants are explicit (`grantPermission`), auditable, and revocable.

Risk levels (`low`, `medium`, `high`, `critical`) drive the confirmation rule: an operation's `requiresConfirmation` flag can only RAISE the bar — if any required permission is `high` or `critical`, human confirmation is mandatory regardless of what the declaration says. The framework never assumes connector actions are safe.

## Operations

A `ConnectorOperation` is a DECLARATION, not an executor: id, name, description, `requiredPermissions`, optional input/output schemas, and `requiresConfirmation`. The manager's `authorizeOperation()` runs the permission gate (operation exists? permissions granted? confirmation needed?) and returns a typed decision — it does NOT execute anything. Execution belongs to the future Tool/Function System, which must route through this gate, collect approval for high-risk operations, and only then invoke the connector.

## Status & lifecycle

`registered → configured → connected → disconnected`, plus `error` and `disabled`. The manager owns the lifecycle; connectors report their own health through `checkHealth()`. New connectors can report status without any change to the core.

## Audit events

Every state change and decision emits a typed, scrubbed `ConnectorAuditEvent` to a registered sink: `connector_registered`, `connector_configured`, `connector_connected`, `connector_disconnected`, `permission_granted`, `permission_denied`, `permission_revoked`, `operation_requested`, `operation_approved`, `operation_rejected`, `operation_completed`, `operation_failed`. Step 4 only defines the event and the sink seam; persistence (append-only storage, search, alerting) arrives later — a future audit pipeline swaps the sink, and no producer changes. Events NEVER contain credentials or secret values.

## The API surface (read-only, for now)

`GET /api/connectors` and `GET /api/connectors/:id` expose metadata, capabilities, permissions, operations, and status ONLY. Credential references are omitted from API responses entirely, and no endpoint can mutate connectors, credentials, or external services. Action endpoints arrive with the Tool/Function System.

## Future connectors (NOT built yet)

| Category                     | Examples                                                  |
| ---------------------------- | --------------------------------------------------------- |
| Source control               | GitHub, GitLab, Bitbucket                                 |
| Database                     | PostgreSQL, MongoDB, Supabase, Firebase                   |
| Storage                      | Cloudflare R2, AWS S3                                     |
| Payments                     | Stripe, Paystack, Flutterwave                             |
| Deployment                   | Vercel, Cloudflare, AWS, GCP                              |
| Communication, analytics, AI | Slack-style, analytics platforms, additional AI providers |

Each will declare its own capabilities and permission catalog; none exists in code today. The mock connector (`@veltravia/connector-mock`) is the only registered connector and simulates nothing — it is a deterministic, offline, credential-free proof that the framework works.
