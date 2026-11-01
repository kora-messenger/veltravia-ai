# Model-powered coding agent

Step 35 turns the coding agent from a scripted demo into an agent that plans and
implements real changes with a real language model - without giving up a single
guardrail from Steps 9, 18 or 32.

The short version: **the model proposes, the engine decides, the human approves,
and nothing is written outside the Tool System.**

## What changed

| Before (Step 9-34)                      | Now (Step 35)                                                                                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decisions came from a scripted source   | Decisions come from a connected provider through the Step 29 execution service                                                                                                                 |
| Plans had goal, steps, files, checks    | Plans also carry the restated request, project understanding, approach, files to create/delete, named risks, validation strategy and approval requirements, plus `origin: 'model' \| 'script'` |
| Whole-file replace only                 | A targeted `patch_file` action that refuses to guess                                                                                                                                           |
| Coarse run states                       | Real phases (`understanding`, `inspecting`, `planning`, `awaiting_approval`, `applying`, `validating`, `diagnosing`, `correcting`, `completed`, `failed`, `cancelled`)                         |
| A run could only be cancelled at a gate | Cancelling aborts the in-flight model call and ends the run as `cancelled`                                                                                                                     |
| The UI said "scripted demo" or nothing  | The UI names the model that answered, or says plainly that none is connected                                                                                                                   |

## The completion port

`@veltravia/coding-agent-model` is provider-neutral. It defines one method:

```ts
interface CodingModelClient {
  readonly providerName: string;
  complete(request: CodingModelRequest): Promise<CodingModelReply>;
}
```

The API implements it on top of `AiExecutionService` (Step 29), so the router
still chooses the model, the gateway still decrypts the credential for exactly
one request, and one usage row is still recorded per call. No second gateway,
no second key store, no vendor SDK in the agent.

A reply that no provider produced (`live: false`) is refused. Fixture and mock
providers can never be presented as model output.

## Bounded context

The prompt builder is deliberately stingy, because a plan that costs a fortune
to produce is not a feature:

- at most 8 files, 4 KB each, 16 KB of evidence in total;
- the plan's own `filesToInspect` list is read first, so the right files survive
  the budget;
- each file is labelled **UNTRUSTED DATA** and the system message says outright
  that project content is never an instruction;
- failing validations are shown with their scrubbed stderr/stdout, and the model
  is asked to diagnose rather than to run another blind command;
- credential-shaped text is redacted before it leaves the process.

The same limits are enforced server-side in the agent's own iteration, tool-call,
consecutive-failure and duration ceilings. The model cannot raise them by asking.

## Decision contract

The model answers with one JSON object per turn:

```json
{ "type": "plan", "plan": { "goal": "...", "steps": [{ "summary": "..." }], "filesToInspect": [], "filesToModify": [], "filesToCreate": [], "validations": [], "acceptanceCriteria": [] } }
{ "type": "action", "action": { "type": "patch_file", "path": "src/app.ts", "find": "const a = 1;", "replace": "const a = 2;" } }
{ "type": "complete", "summary": "..." }
{ "type": "fail", "reason": "..." }
```

Parsing is strict and has exactly **one** repair attempt: an unparseable answer
is sent back with a short "that was rejected, answer with the JSON object only"
note, and a second failure ends the run as `CODING_MODEL_INVALID_OUTPUT`. No
action is ever taken from a partially parsed object. An unknown decision type
fails the run instead of being ignored.

## The patch action

`patch_file` replaces exactly one occurrence of `find` with `replace`:

- zero occurrences → refused (`the text to replace was not found`);
- two or more → refused with the count, so the model can be more specific;
- the file must have been read in this run, so a patch is never a blind write;
- `expectedRevision` may be supplied, and a stale value is rejected by the
  Project Engine (a model cannot overwrite a file it has not seen);
- secret-shaped content is rejected before the write, by the same rule as every
  other coding action.

The agent never guesses which match was meant. A test asserts the file is
byte-identical after an ambiguous patch, and another asserts the model is told
the reason on its next turn.

## Honest capability reporting

`GET /api/coding/capabilities` answers per caller:

```json
{
  "capabilities": {
    "decisionSource": "model",
    "unavailableReason": null,
    "phases": ["understanding", "..."],
    "planApprovalRequired": true
  }
}
```

- `model` - this owner has a working provider connection;
- `unavailable` - with a reason in plain words ("Connect a provider in Settings
  before a model can plan this change");
- `scripted-demo` - only when the server was started with
  `VELTRAVIA_CODING_DEMO=1`, and the UI says the plan came from the offline
  script;
- `injected` - tests and other hosts that supply their own decision source.

`POST /api/coding/runs` refuses with `409 CODING_MODEL_UNAVAILABLE` when this
owner has no provider. It never silently falls back to a script: a plan that
looks like a model's but is not is worse than an honest refusal.

## Provenance and run view

Every run payload now includes:

- `phase` - the concrete step (`diagnosing` is not `validating`);
- `plan.origin` - `model`, `script` or `unknown`;
- `model` - `{ used, providerId, providerName, modelId, live, decisions }`, ids
  only, never a credential;
- `validationResults` - each command with `passed`, `status`, `exitCode` and
  `timedOut`.

The builder panel shows all four: a "Planned by OpenAI · gpt-4.1-mini" line, the
phase, the checks that ran, and - when nothing is connected - an explicit note
that nothing is being simulated.

## Cancellation

`POST /api/coding/runs/:id/cancel` now aborts the model call itself, so
cancelling stops the spend instead of only making the answer unread. A
cancellation that lands while the model is thinking ends the run as `cancelled`,
never as a failure the run did not cause.

## Rate limits and pacing

A coding run spends one model call per decision, so it meets provider rate
limits that a single chat turn never would. Three things keep that honest:

- **The provider's own wait is obeyed.** A 429 that states `retry_after` or
  Gemini's `details[].retryDelay` is waited out (capped at 20s) instead of being
  retried after 250ms, which is what used to spend a whole minute of quota
  failing.
- **A stated-wait-free 429 still waits.** When no hint is given, a rate-limited
  call waits at least 5s before retrying (`rateLimitFloorMs`), because metered
  tiers count per minute.
- **Calls can be paced.** `VELTRAVIA_CODING_MODEL_MIN_INTERVAL_MS` sets the
  shortest gap between completions in one run (default off). A free-tier key
  needs it; a paid key does not.

The refusal also names the provider's reason when it gave one, so an exhausted
daily quota reads as an exhausted daily quota rather than a generic
"rate limiting".

What this does not do: it cannot make an exhausted quota work. A free tier that
has spent its daily allowance refuses every call until it resets, and the run
ends as a typed failure saying so.

## What is still not done

- No local or open-weight provider is special-cased; whatever the gateway can
  route to is what the agent uses.
- The agent cannot install dependencies, run a build outside the sandbox
  allowlist, or reach the network during validation.
- A run holds one workspace revision at a time; concurrent humans editing the
  same files still surface as a stale-revision failure rather than a merge.
- Retries are bounded (one repair, then a typed failure). There is no long
  autonomous loop and there is no self-approval path - by design.

## Tests

- `coding-agent/model/src/model.test.ts` - 18 unit tests: parsing, redaction,
  context budget, repair, provenance, secrets, cancellation, provider errors.
- `coding-agent/model/src/agent-integration.test.ts` - 9 integration tests
  against the real agent, Tool System, Project Engine and mock sandbox.
- `tests/api-coding-model.test.ts` - 7 API tests: per-owner capability,
  409 refusal, scripted opt-in, approval-gated write, unparseable answer,
  provider outage, and no credential in any response.
- `ai/gateway` - 106 tests, including a run that waits as long as the provider
  asks on a rate limit and gives up once the ceiling is reached.
- `apps/web/src/api/coding.test.ts`, `apps/web/src/pages/builder/BuilderChatPanel.test.tsx`
  - provenance, phase and validation presentation, and the honest
    no-model state.
