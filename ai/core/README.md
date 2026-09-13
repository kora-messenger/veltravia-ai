# ai/core/

**Implemented in Step 2 — AI Core.** The provider-neutral AI abstraction layer of Veltravia AI. `@veltravia/ai-core`.

| Module              | Responsibility                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/types/`        | The normalized vocabulary: `AIMessage`, `AIRequest`, `AIResponse`, `AIModelInfo`, `AIUsage`, `AICapability`     |
| `src/provider/`     | The `AIProvider` interface every vendor adapter must implement                                                  |
| `src/registry/`     | `ModelRegistry`: the single source of truth for models, capabilities, availability                              |
| `src/router/`       | `AIRouter`: deterministic selection (explicit model → configured default → capability scan)                     |
| `src/errors/`       | The normalized error system (`InvalidAIRequestError`, `ModelNotFoundError`, `CapabilityNotSupportedError`, ...) |
| `src/config/`       | Routing/limit configuration from the environment - no secrets, ever                                             |
| `src/core.ts`       | `AICore`: the facade the rest of the platform calls (`generate()`)                                              |
| `src/validation.ts` | `validateAIRequest`: strict request validation with collected issues                                            |

Design rules: vendor API formats never cross the package boundary; adding a provider means writing one adapter and registering its models - nothing else changes. See [docs/architecture.md](../../docs/architecture.md) and [docs/security.md](../../docs/security.md).
