# Real-model execution (Step 29)

The execution surface is the one place a model actually answers. It sits behind the
[provider gateway](ai-providers.md) and the [model router](model-routing.md):
the router decides **which** model runs, the gateway **makes the call**, and this
layer turns that into a run a human can watch.

```
POST /api/ai/execute
        │
        ├─ router.route()        → which connection + model, and why
        ├─ prepareContext()      → fits the window, scrubs secrets
        ├─ gateway.stream()      → real SSE from the provider, or one-piece
        └─ usage record          → tokens, cost provenance, latency, attempts
```

## Endpoints

| Method | Path                                   | What it does                                                     |
| ------ | -------------------------------------- | ---------------------------------------------------------------- |
| `GET`  | `/api/ai/execution`                    | Readiness, blocked reason, task categories, limits               |
| `POST` | `/api/ai/execute`                      | Start a run. `Accept: text/event-stream` streams; otherwise JSON |
| `GET`  | `/api/ai/execution/runs`               | This owner's recent runs                                         |
| `GET`  | `/api/ai/execution/runs/:runId`        | One run plus its events (`?since=` for a delta)                  |
| `POST` | `/api/ai/execution/runs/:runId/cancel` | Cancel a live run                                                |
| `GET`  | `/api/ai/execution/usage`              | Usage history with tokens and cost provenance                    |

## Events

`run.started` → `progress` → `route.selected` → `context.prepared` → `delta`* →
`usage` → `run.completed` | `run.failed` | `run.cancelled`.

Each event carries a `runId`. A terminal event is sent exactly once. Closing the
connection cancels the run, so no provider keeps generating for a tab that left.

## What is guaranteed

- **The router alone chooses the model.** A caller can name a model, but the
  platform never quietly swaps in another one. When routing refuses, the run fails
  with the refusal (`GATEWAY_ROUTE_UNAVAILABLE`) and no request is made.
- **Streaming is real.** Fragments are parsed and yielded as they arrive from the
  provider, not buffered and replayed. Providers that cannot stream return one
  piece and the run says `streamed: false`.
- **Cancellation is honest.** A cancelled run is recorded as `cancelled` with a
  `cancelled` category. It is never recorded as a success, and it never keeps a
  confirmed cost.
- **Retries are bounded and classified.** Rate limits, timeouts, 5xx and transport
  failures retry with backoff. Auth failures, bad requests and capability gaps do
  not. One usage row per run records how many attempts it took.
- **Tokens are reported, not guessed.** `usageSource` is `provider-confirmed` only
  when the provider stated counts. Otherwise it is `unavailable` and the token
  fields are `null`.
- **Costs require a declared price.** `costSource` is `declared-pricing` only when
  `VELTRAVIA_MODEL_PRICING` declares a price for that provider and model. With no
  price, `estimatedCostUsd` is `null` and the UI says the cost is unknown.
- **One run per idempotency key.** Repeating the key returns the same run instead
  of paying the provider twice.
- **Owner isolation.** Runs, usage and cancellation are scoped to the caller. A run
  belonging to someone else answers `404`, exactly like a run that never existed.

## Configuration

| Variable                   | Purpose                                                                      |
| -------------------------- | ---------------------------------------------------------------------------- |
| `VELTRAVIA_CREDENTIAL_KEY` | Vault key. Without it, providers cannot be used at all (503).                |
| `VELTRAVIA_MODEL_PRICING`  | JSON prices: `{"openai":{"gpt-4.1":{"inputPer1MUsd":2,"outputPer1MUsd":8}}}` |

## Honest limits

- Usage history is in process memory; a restart clears it. Durable accounting is a
  later step, and no invoice is claimed.
- The browser reads the stream with `fetch`, not `EventSource`, because a task is a
  `POST`. Very old browsers without a readable body get an explicit error instead
  of an empty answer.
- Nothing here chooses a _cheaper_ model behind your back: budget policy is the
  router's, and it is shown in the route explanation.

## Web surface

`#/execute` ("Model runs") shows the readiness chip, the task form, the streamed
answer, the route and its explanation, token provenance, cost provenance, and a
Stop button that cancels on the server. With no provider connected the page says
so and the request fails honestly.
