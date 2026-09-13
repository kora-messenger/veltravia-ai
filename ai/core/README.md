# ai/core/

The provider-agnostic AI router. Responsibilities once implemented (Step 2):

- a single request interface for all AI calls, independent of vendor
- retry, timeout, and circuit-breaker logic so one dead provider cannot stall the platform
- token/cost budget enforcement per request, per user, and per run

**Intentionally empty in Step 1.** Becomes an npm workspace (`@veltravia/ai-core`) when implementation starts.
