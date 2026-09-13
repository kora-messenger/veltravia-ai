# @veltravia/connector-mock

A deterministic, offline, credential-free mock connector. It exists only to prove the connector framework works - registration, validation, permissions, operations, lifecycle, and health reporting - and simulates NO external service (it is not a "fake GitHub"; it is a plain, pure object).

- No external credentials, no network requests, no I/O of any kind.
- Fully deterministic: an injected clock drives every timestamp (CI-safe).
- Implements the provider-neutral `Connector` interface from `@veltravia/connector-core`.
- Declares generic fake capabilities (`read`, `write`, `search`), a permission catalog with all four risk levels, and four operations including a critical-risk one for confirmation testing.
