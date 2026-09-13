# ai/providers/

One adapter package per AI provider, each implementing the `AIProvider` interface from `@veltravia/ai-core`. The router never imports vendor SDKs directly - only adapters do. The vendor's request/response format exists ONLY inside an adapter; everything else speaks Veltravia's normalized types.

```
ai/providers/
├── mock/        # IMPLEMENTED (Step 2): deterministic, offline, keyless provider
├── gemini/      # IMPLEMENTED (Step 3): Google Gemini via the official Interactions API
├── openai/      # FUTURE
├── anthropic/   # FUTURE
└── ...          # FUTURE
```

## How an adapter works

The Gemini adapter (`ai/providers/gemini`) is the reference implementation:

1. Create `ai/providers/<name>/` as an npm workspace named `@veltravia/ai-provider-<name>`, depending on `@veltravia/ai-core`.
2. Implement `AIProvider`: translate the normalized `AIRequest` into the vendor's format and the vendor's response back into the normalized `AIResponse`.
3. Convert every vendor error into the normalized error classes (`AIProviderError` etc.) - vendor error shapes must never leave the adapter.
4. Register the adapter's models (id, capabilities, limits) into the `ModelRegistry` at bootstrap.
5. Read its API key from the secret manager at runtime - never from code, never from `.env` in the repo.
6. Add the package to the root `workspaces` and build order; CI picks it up automatically.

Because every adapter satisfies the same interface, Veltravia AI stays independent of any single AI company - providers can be added, removed, or reordered without touching application code.
