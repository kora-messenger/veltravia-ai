# ai/ — AI orchestration (future)

Provider-agnostic AI layer. **Step 2 scope — no code yet.**

- `core/` — the AI router: dispatch, retries, timeouts, budgets, circuit breakers
- `providers/` — one adapter per provider behind a shared interface
- `agents/` — planner, builder, reviewer, debugger agent definitions
- `prompts/` — versioned prompt templates, reviewed and tested like code
