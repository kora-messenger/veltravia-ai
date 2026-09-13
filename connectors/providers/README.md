# connectors/providers/

Individual connector implementations, each its own package depending on `@veltravia/connector-core` (e.g. `@veltravia/connector-github`, `@veltravia/connector-postgres`).

**FUTURE - intentionally empty.** The mock connector used to prove the framework lives in `connectors/mock/` (Step 4); real vendor connectors arrive in later steps and will never require core changes - each implements only the provider-neutral `Connector` interface.
