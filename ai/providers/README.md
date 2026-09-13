# ai/providers/

One adapter package per AI provider, each implementing the shared interface defined in `ai/core`. The router never imports vendor SDKs directly — only adapters do.

**Intentionally empty in Step 1.** No provider integrations (OpenAI, Anthropic, Google, OpenRouter, …) are implemented yet; each becomes its own workspace (`@veltravia/ai-provider-*`) in Step 2.
