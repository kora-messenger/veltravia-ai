# Veltravia AI — The Integration Layer (Step 12)

## What is an integration?

An **integration** is the user-facing unit of external connectivity: a named service (source control, storage, a database, a payments provider) with a declared manifest, a scope catalog, a tool catalog, and **connections** — the owner-scoped instances the user actually connects and grants scopes to. The integration layer sits ABOVE the Step 4 connector framework: it turns "there is a connector with operations" into "here is a catalog entry the owner can connect, inspect, and revoke", and it is the surface the API and the web UI render.

The layer shipped in Step 12 (`integrations/core` + `connectors/integration-mocks` + the migrated `connectors/github` integration) is **plumbing, not an agent**. It never decides what the user wants, never calls an LLM, never executes code, and never touches the network by itself. Operations execute only through the Step 5 Tool System, whose `connectorExecutor` seam forwards authorized invocations to the integration runtime.

```
        Agent / Coding agent
               |
      Tool System (Step 5)        authorize + confirm + validate
               |
   connectorExecutor seam         (Tool System → integration runtime)
               |
   Integration Runtime           (13-step pipeline, fail-closed)
               |
   Integration Registry          (strict manifest validation)
               |
  ┌────────────┼────────────┐
 GitHub   Mock Storage   Mock Database   ...   (one package each)
```

## Package layout

- `integrations/core` (`@veltravia/integration-core`) — the provider-neutral core: domain types (categories, lifecycle, manifest), strict manifest validation, the registry, the connection manager (owner boundary), the secret boundary, the runtime (execution pipeline), typed scrubbed errors, and bounded audit events.
- `connectors/integration-mocks` (`@veltravia/integration-mocks`) — deterministic offline **Storage** and **Database** integrations used by tests and by the development API. No host code, no network.
- `connectors/github` — the existing GitHub source-control integration, now defined as an explicit hand-written `IntegrationDefinition` (no generic derivation from connector metadata).

## The manifest and the registry

Every integration ships a declarative `IntegrationDefinition`: id, name, publisher, version, category, icon ref, authentication type, capabilities, a **scope catalog** (each scope: id, description, risk level), a **tool catalog** (each tool: operation id, name, description, required scopes, risk level, confirmation requirement), environments, and optional documentation. The registry accepts a definition only when the manifest passes **strict validation** — ids, catalog shapes, duplicates, and scope references (a tool may only require scopes the integration declares) are all checked. Registration grants nothing else: it puts metadata in a catalog.

## Connections and the owner boundary

A **connection** is one instance of an integration for one owner: an id, a status (`connected | disconnected | disabled | error`), an optional account ref label, and the list of **granted scopes**. The connection manager enforces the **owner boundary**: every lookup and every mutation is scoped to the owner that created the connection; a foreign or unknown connection id fails closed with a typed error. Connections can be disabled (operations fail closed until re-enabled) and disconnected (terminal for that connection id). Lifecycle transitions are validated; `disconnected` is terminal.

Credential material never lives in a connection and never travels through this layer. The `SecretStore` boundary resolves a secret **inside the runtime only**, keyed by integration id and connection id; the value is handed to the executor as a getter and never stored, logged, or returned in any view.

## The runtime pipeline (13 steps, fail-closed)

`IntegrationRuntime.execute` runs one operation through an ordered pipeline. Every failure is a typed, sanitized `IntegrationError` — provider detail never leaks, and every denial is audited:

1. Resolve the integration (unknown id → typed not-found).
2. The integration must be **enabled**.
3. Resolve the connection **inside the owner boundary** (fail closed).
4. The connection must be `connected` (anything else fails closed).
5. The operation must be **declared by the integration's tool catalog**.
6. **Authorization**: the connection's granted scopes must cover the tool's required scopes (missing → typed error + audit).
7. **Risk gate**: high/critical operations must arrive through the Tool System confirmation gate; this layer refuses to be a bypass around it.
8. **Credential retrieval inside the boundary** — a getter, resolved only if the integration requires authentication; the value is never retained.
9. The registered **executor** runs the operation with validated input and the connection context.
10. The raw result is **scrubbed and shape-checked** (plain objects only, no symbols).
11. Output is validated against the operation's declared output shape.
12. The result is normalized to a bounded safe view.
13. Every outcome — executed, failed, denied — writes a bounded **audit event**.

The pipeline also records a **status check** on the connection (healthy/error) so owners can verify connectivity on demand, and counts operations per connection.

## Execution is Tool-System-gated

The agent layer never talks to the runtime directly. Agents request tools; the Tool System validates input, checks permissions, enforces human confirmation for high/critical risk, and only then invokes the `connectorExecutor` seam. The seam forwards the request with `confirmationGated: true` after its own gate passed — the runtime re-checks (step 7) so there is no path around it. Tool results return to agents as UNTRUSTED DATA (Step 6 rules unchanged).

## Audit and errors

- Every execution, denial, failure, and status check emits a bounded audit event (integration id, operation id, connection id — never secrets, never raw input).
- `IntegrationError` subclasses (`IntegrationNotFoundError`, `MissingScopeError`, `IntegrationExecutionFailedError`, `IntegrationCredentialUnavailableError`, …) carry sanitized messages; provider internals and stack traces are scrubbed before anything surfaces.
- Safe views (`integrationToSafeView`, connection views) are the ONLY shapes the API and the web UI render — metadata and connection status, never credential material.

## API surface (`apps/api`)

- `GET /api/integrations` — the catalog (safe views + the owner's connections).
- `GET /api/integrations/:id` — one integration.
- `POST /api/integrations/:id/connections` — connect with explicitly chosen scopes (validated against the declared catalog).
- `POST …/connections/:connectionId/disable` / `enable` — lifecycle.
- `POST …/connections/:connectionId/status-check` — run a status check.
- `DELETE …/connections/:connectionId` — disconnect (terminal).

Credential material is never accepted or returned by any route. Development runs register the mock Storage + Database integrations and the GitHub integration; the demo storage agent exercises the full path end-to-end.

## Web UI (`apps/web`)

The Integrations page (`#/integrations`) renders the catalog: scopes with risk levels, tools with confirmation requirements, connections with status and granted scopes, and owner actions (connect with explicit scope selection, disable/enable, status check, disconnect). It is a presentation surface only — no credential material exists anywhere in web source, and actions are honest: server rejections surface as typed errors, never fabricated success.

## What is deliberately NOT here

- No OAuth handshake flows (a future step wires real authorization redirect flows into the connection lifecycle).
- No automatic scope grants, no silent re-enabling, no background execution.
- No new agent capabilities: the runtime executes only what the Tool System authorizes.
