# AI providers and bring-your-own-key (Step 26)

The gateway lets the platform use **your** model account. Every reasoning path
that previously had only a deterministic simulation can now run on your own
provider, while everything else - tool grants, confirmations, limits, evidence
verification, disclosure - stays exactly as it was.

```
ai/gateway
├── providers/   catalog + 3 adapter shapes (OpenAI-compatible, Anthropic, Gemini)
├── vault/       AES-256-GCM credential sealing, owner-scoped access, key versions
├── ssrf/        https-only endpoint guard with per-request DNS re-checks
├── gateway/     connections, model registry, routing, usage, scoped AICore
└── bridges/     adapters that make agents, documents and intelligence use it
```

## What ships

| Piece                                                | State                                                     |
| ---------------------------------------------------- | --------------------------------------------------------- |
| Provider catalog (10 vendors)                        | Real declarations, documented auth shape and capabilities |
| OpenAI-compatible adapter                            | Real HTTP implementation                                  |
| Anthropic adapter                                    | Real HTTP implementation (`/v1/messages`)                 |
| Gemini adapter                                       | Real HTTP implementation (`generateContent`)              |
| Custom OpenAI-compatible endpoint                    | Real, SSRF-guarded, https-only                            |
| Credential vault                                     | AES-256-GCM, per-record IV, key versions, fail-closed     |
| Model discovery                                      | Real `GET /models` per provider, with manual fallback     |
| Usage telemetry                                      | Real, metadata only, cost `null` when no reliable price   |
| Agents / documents / intelligence on your provider   | Wired, opt-in per run                                     |
| Non-chat providers (image, audio, video, embeddings) | Declared in the catalog only; no adapter yet              |

No provider key is bundled with the platform, and no code path invents one.

## Using it

1. Generate a key at the provider.
2. Open **Settings → AI providers**, choose the vendor, paste the key once.
3. **Verify** calls the provider and reports how many models answered.
4. Pick a default model per connection, and mark one connection as the default.
5. Ask for it explicitly:
   - Agents: `POST /api/agents/run` with `reasoning: "gateway"`.
   - Documents: `reasoning: "gateway"` on a processing request.
   - Intelligence: `reasoning: "gateway"` on `/api/intelligence/analyze`.

Without that flag each service keeps using its deterministic provider, and each
answer keeps saying so.

## API

| Method | Path                                            | Purpose                                                       |
| ------ | ----------------------------------------------- | ------------------------------------------------------------- |
| GET    | `/api/ai/providers`                             | readiness, encryption info, connections, preferences, catalog |
| GET    | `/api/ai/providers/catalog`                     | vendor declarations only                                      |
| POST   | `/api/ai/providers/connections`                 | store a key (encrypted) and discover models                   |
| PATCH  | `/api/ai/providers/connections/:id`             | label, default model, models, status                          |
| POST   | `/api/ai/providers/connections/:id/validate`    | live verification -> `{ valid, errorCategory, connection }`   |
| GET    | `/api/ai/providers/connections/:id/models`      | cached or `?refresh=true`                                     |
| POST   | `/api/ai/providers/connections/:id/credential`  | replace the key                                               |
| POST   | `/api/ai/providers/connections/:id/keys`        | add another key to the pool (`201`)                           |
| DELETE | `/api/ai/providers/connections/:id/keys/:keyId` | remove one pooled key; the last key stays                     |
| DELETE | `/api/ai/providers/connections/:id`             | remove connection and credential                              |
| PUT    | `/api/ai/providers/preferences`                 | default connection and model                                  |
| GET    | `/api/ai/providers/usage`                       | metadata-only history                                         |
| POST   | `/api/ai/providers/generate`                    | one direct chat completion                                    |

### Verification results

`validate` never returns provider wording and never returns the key. It answers
with `valid`, a normalized `errorCategory` when the check failed, and the
re-read `connection` so the caller sees the status the check produced. The
settings page turns the category into a plain sentence (rejected key, rate
limited, timed out, refused endpoint, undecryptable key, unreachable, provider
error) and falls back to "the provider did not confirm the key" for a category
it does not recognize, so no raw code ever reaches the screen.

A repeated provider + key pair is refused with `409 GATEWAY_CONNECTION_DUPLICATE`
rather than stored twice. That is why the live browser QA now uses a fresh key
per pass.

## Several keys per connection

A provider key is a bucket of quota, not a switch. Free tiers meter per key per
model, so a connection can hold a pool of keys (8 by default) and one exhausted
key no longer fails the run.

- **Rotation, not retry.** A rate-limited key is tried once, then the next key
  serves the same request. Waiting is what the last key does, never the first.
- **Cooldowns are real.** A key that refused cools for exactly the wait the
  provider asked for, or one minute when it said nothing, and returns on its
  own. A key the provider rejects as unauthenticated is retired and never spent
  again.
- **Load spreads.** The least recently used key is tried first, so one key does
  not carry every request while another sits idle.
- **Refusals are specific.** When every key is spent the answer is
  `429 GATEWAY_RATE_LIMITED` with `details.reason = 'all-keys-cooling'`, the
  number of keys and the soonest reset ("the soonest frees up in 42s"). When
  every key was rejected it is `GATEWAY_AUTH_FAILED` with
  `reason = 'all-keys-invalid'`. Neither case pretends the vendor is down.
- **A new key is checked before it joins.** `POST .../keys` validates the key
  with the provider first, so a key that cannot authenticate never sits in the
  pool pretending to be capacity.
- **One key is decrypted per attempt.** The pool stores references; plaintext
  exists only for the attempt about to run, so eight keys widen nothing.
- **A view shows masks, never secrets.** Each key reports `hint`, `status`,
  `cooldownUntil`, `lastUsedAt` and `lastErrorCategory`. No vault reference and
  no key material crosses the API boundary.

Streaming rotates too, but only before the first fragment: once text has reached
the caller the answer cannot be restarted on another key without duplicating it.

## Routing

The route for a request is resolved in this order:

1. an explicit model id on the request, if that connection exposes it;
2. the per-project preference;
3. the owner's default model;
4. the preferred connection's first model;
5. the first model of the first usable connection.

The resolved route reports its `source` (`project`, `default` or `explicit`) so an
answer can say where the model choice came from.

## Honest limits

- **A pool is not a free tier bypass.** Rotating keys multiplies daily quota only
  as far as the keys you actually hold; it does not create capacity.
- **No key means no answer.** With nothing connected the gateway returns
  `409 GATEWAY_NO_PROVIDER_CONFIGURED`. It does not fall back to a shared key.
- **No encryption key means no storage.** The page shows the blocker and offers no
  connect button; writes return `503 GATEWAY_VAULT_UNAVAILABLE`.
- **Key rotation is manual.** Key versions are recorded and old versions stay
  readable while the current one seals new records; there is no automatic re-seal job.
- **Usage cost is often unknown.** Prices are only reported where the catalog has a
  reliable figure; otherwise the field is `null` and the UI says cost is not estimated.
- **Usage history is in-process.** A restart clears it, like the rest of the
  in-memory stores in this build.
- **Discovery can fail.** A provider that hides its model list needs the manual
  model field; the connection still works.
- **Only chat-shaped providers have adapters.** Image, audio, video and embeddings
  are declared so the UI is honest, not to imply they run.

## Testing

`ai/gateway` ships a fixture transport (`@veltravia/ai-gateway-mock`) that answers
without opening a socket. Core tests cover encryption, tampering, owner isolation,
routing, SSRF, discovery and failure mapping; `tests/api-ai-gateway.test.ts` drives
the real Fastify app end to end against that fixture.

Live provider tests are opt-in and skipped by default in CI:
`RUN_OPENAI_INTEGRATION_TESTS`, `RUN_ANTHROPIC_INTEGRATION_TESTS`,
`RUN_GEMINI_INTEGRATION_TESTS` plus the matching key variable.
