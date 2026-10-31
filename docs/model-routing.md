# Model routing (Step 28)

One decision seam decides which model runs a task. Nothing in the platform picks a
model on its own any more: reasoning runs and provider generation both ask the router,
and the router answers from the caller's own connections.

## What ships

- `@veltravia/ai-router` - a normalized model catalog, 11 task categories, automatic /
  manual / project routing, owner preferences, and a plain-language explanation for
  every decision.
- A capability check that runs **before** a model is chosen. A task no connected model
  can serve is refused with a sentence saying what is missing, never routed to a
  near-enough model.
- Execution evidence: successes, failures and latencies reported by the callers feed
  outage pausing and the "faster" preference.
- `/api/ai/router` - catalog, per-task support, preferences, route, decisions, outcomes.
- `#/settings/models` - the routing screen: connected models with capability provenance,
  what each model can and cannot do, an "Explain the choice" check that runs the real
  router, and per-project overrides.

## Task categories

| Category                | Needs                              | Notes                       |
| ----------------------- | ---------------------------------- | --------------------------- |
| `general-conversation`  | text-generation                    | Chat and everyday questions |
| `complex-reasoning`     | text-generation, structured-output | Multi-step analysis         |
| `code-generation`       | text-generation, code-generation   | Writes code                 |
| `code-review`           | text-generation, code-generation   | Reads and critiques code    |
| `document-analysis`     | text-generation, large-context     | Long documents              |
| `long-context`          | text-generation, large-context     | Whole-repository questions  |
| `structured-extraction` | text-generation, structured-output | Typed fields out of text    |
| `tool-use`              | text-generation, tool-calling      | Tools and connectors        |
| `image-understanding`   | vision                             | Reads images                |
| `image-generation`      | image-generation                   | Creates images              |
| `embeddings`            | embeddings                         | Vectors                     |

Two more are declared with a structural gap so the platform can say "not yet" honestly:
`audio-understanding` and `video-understanding`. They never silently fall back to a text
model.

## How a decision is made

1. **Explicit request.** A caller that names a connection and model gets that model, or a
   refusal (`ROUTER_PREFERENCE_UNUSABLE`) if the model is not on that connection, does not
   belong to the caller, or lacks a required capability.
2. **Task preference.** A model pinned for this category in preferences.
3. **Project preference.** A model pinned for this project. It overrides the account
   default for that project only; another owner's project is `ROUTER_DECISION_NOT_FOUND`.
4. **User default.** The default model saved in preferences.
5. **Automatic.** Capability-compatible candidates, scored by readiness (a validated
   connection beats an unvalidated one), then by the preference (faster, stronger
   reasoning, cost), then by registry order as a stable tiebreak.

Each step is recorded: `decidedBy` says which rule applied, `rejected` lists the models
that were considered and why they lost, and `summary` is one sentence written for a
person, not for a log.

## Honest limits

- **Cost is never claimed.** No reliable per-model pricing is configured, so a
  `lower-cost` preference reports `costComparison: 'unavailable'` and a warning saying the
  choice is not a claim about being cheapest. It never invents a price.
- **Speed needs evidence.** The "faster" preference ranks on latencies actually reported
  in this server session. With no evidence it says so instead of guessing.
- **Fallback is explicit and never double-bills.** A fallback happens only when the owner
  allows it, only to a model that satisfies the same capabilities, only once per request,
  and never after the first attempt has been billed - a failed attempt that consumed
  tokens is not retried silently.
- **Outage pausing is bounded.** Repeated failures for one provider+model pause it for a
  short window so the next request does not repeat the failure; one failure alone does not
  pause anything.
- **Decision history is in-process.** Preferences and decisions live in memory for this
  server process and are lost on restart. The API and the page both say so.
- **No provider text reaches the database.** Rejections and errors are category-coded, so
  a vendor's message never ends up in a decision record.

- **A refusal is data, not an error.** `POST /api/ai/router/route` is advisory: when
  nothing can serve the category it answers 200 with `outcome: 'unsupported'` and a plain
  sentence, so the screen can explain itself. Malformed input still fails with 400/409.
- **One reason per state, never the wrong one.** `No provider is connected yet` is used
  only when the owner has no connections at all; a connection that exists but cannot run
  says so and repeats the gateway's own explanation (for example, that it failed its last
  check). The two states need different fixes, so they never share a sentence.

## Integration points

- **Reasoning (Step 27).** A gateway run with no explicit model calls the router with the
  `reasoning` category. A refusal becomes an honest error, not a silent substitution.
- **Provider gateway (Step 26).** `POST /api/ai/providers/generate` without a model routes
  first, returns the decision alongside the answer, and records the latency as evidence.
  Saving preferences on the routing screen mirrors the default and project choices into
  the gateway's own preference store, so the agent layer, coding agent, documents and
  cross-source intelligence use the same config instead of a second one.

## API

| Method | Path                           | Purpose                                                                 |
| ------ | ------------------------------ | ----------------------------------------------------------------------- |
| GET    | `/api/ai/router`               | Catalog, task support, capability counts, preferences, persistence note |
| GET    | `/api/ai/router/preferences`   | Current preferences                                                     |
| PUT    | `/api/ai/router/preferences`   | Save preferences; reports whether they reached execution                |
| POST   | `/api/ai/router/route`         | Advisory decision for a category (always 200 with `decision.outcome`)   |
| GET    | `/api/ai/router/decisions`     | Recent decisions, newest first                                          |
| GET    | `/api/ai/router/decisions/:id` | One decision, owner-scoped                                              |
| POST   | `/api/ai/router/outcomes`      | Report a real execution result (204)                                    |

## Security

Rules are in [security.md](security.md) section 5s. In short: a decision can only name a
model on the caller's own connection, decisions are owner-scoped so another owner's id is
indistinguishable from a missing one, no credential or endpoint ever appears in a
decision or on the page, and the routing surface can never execute a model call.

## Testing

- 43 router package tests: catalog normalization, capability gating, each routing rule,
  preference validation, project and task overrides, fallback rules, outage pausing,
  explanation quality and owner isolation.
- 16 API tests: empty catalog, capability provenance, no credential leakage, per-category
  support, refusals with a plain sentence, cross-owner connection and project refusals,
  decision history isolation, preference mirroring into the gateway, and the generation
  seam (routed, refused, evidence recorded).
- 9 page tests: model list, unsupported tasks, the explanation flow, project id handling,
  save failure, mirror failure, empty catalog and load failure.

The full suite and live QA numbers are recorded in the project README.
