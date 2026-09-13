# ai/ — AI orchestration

- `core/` — **IMPLEMENTED (Step 2)**: provider-neutral types, provider interface, model registry, deterministic router, typed errors, configuration
- `providers/` — `mock/` **IMPLEMENTED (Step 2)**; `gemini/` **IMPLEMENTED (Step 3)** (Google Gemini via the Interactions API); further adapters (OpenAI, Anthropic, ...) are FUTURE
- `agents/` — FUTURE: planner, builder, reviewer, debugger agent definitions on top of `ai/core`
- `prompts/` — FUTURE: versioned prompt templates, reviewed and tested like code
