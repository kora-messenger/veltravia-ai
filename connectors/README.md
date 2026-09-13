# connectors/ — the connector framework

A **connector** is a controlled integration between Veltravia AI and an external service. The framework is provider-neutral: the core contains no vendor SDKs, no vendor types, and no vendor assumptions - every future connector implements the same `Connector` interface.

```
connectors/
├── core/       # @veltravia/connector-core - IMPLEMENTED (Step 4)
└── mock/       # @veltravia/connector-mock - IMPLEMENTED (Step 4)
```

## Architecture

```
        AI Core
           |
   Tool / Function System        (Step 5 - future)
           |
   Connector Manager              (permissions gate, lifecycle, audit)
           |
     Connector Interface         (provider-neutral contract)
           |
  ┌────────┼──────────┐
GitHub  Database  Storage  ...   (future, one package each)
```

## Packages

- **`core/`** — the interface, typed metadata, categories, capabilities, the permission system, credential **references** (never values), operation declarations, the registry, the manager, typed errors, and audit events. Read [core/README.md](core/README.md).
- **`mock/`** — a deterministic, offline, credential-free connector that proves the framework works. It simulates nothing; it is safe for CI. Read [mock/README.md](mock/README.md).

## Credential isolation (critical)

The core never stores or transports raw secrets. A `CredentialReference` is a metadata-only pointer (`credentialId`, type, `providerRef`, status); the actual secret lives in a Secure Credential Store outside the framework. See [docs/security.md](../docs/security.md).

## Future connectors (NOT built yet)

GitHub, GitLab, Bitbucket (source control) · PostgreSQL, MongoDB, Supabase, Firebase (databases) · Cloudflare R2, AWS S3 (storage) · Stripe, Paystack, Flutterwave (payments) · Vercel, Cloudflare (deployment) · and more. Each will be its own package under `connectors/providers/`, implementing only the `Connector` interface - the core never changes to accommodate a vendor.
