# Reasoning engine (Step 27)

A bounded, observable reasoning loop on top of the Step 26 provider gateway. The
model plans, calls read-only tools, and answers. Every step is recorded, every
answer says which provider produced it, and nothing risky runs without a human
decision.

## Packages

| Package                                        | Purpose                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `reasoning/core` (`@veltravia/reasoning-core`) | Profiles, limits, task classification, plan validation, the engine, streaming events, usage records, typed errors. |
| `reasoning/mock` (`@veltravia/reasoning-mock`) | A deterministic simulated provider for tests and offline demos. Always discloses `simulated: true`.                |
| `apps/api`                                     | `/api/reasoning` surface and the per-owner engine registry.                                                        |
| `apps/web`                                     | `#/reasoning` workspace page.                                                                                      |

## Profiles

A profile decides which context kinds and which tools a run may use.

| Profile          | Tool prefixes                              | Typical use                                 |
| ---------------- | ------------------------------------------ | ------------------------------------------- |
| `workspace`      | `project.`, `codebase.`, `files.`, `mock.` | Questions about a project and its workspace |
| `document`       | `documents.`, `files.`                     | Questions about parsed documents            |
| `intelligence`   | `intelligence.`                            | Cross-source questions with citations       |
| `agent`          | `project.`, `files.`, `sandbox.`           | General agent work                          |
| `coding`         | `project.`, `codebase.`, `sandbox.`        | Code tasks                                  |
| `connected-apps` | `connections.`                             | Connected-app resources                     |

A profile is a filter, not a grant. The Tool System still decides availability and
still demands a human confirmation for anything risky.

## The loop

1. **Validate** the request (task length, profile, limits).
2. **Classify** the task (`question`, `analysis`, `action`, `summarize`, …) and
   whether tools are needed.
3. **Plan** a short, validated list of steps. An invalid plan fails the run.
4. **Execute** step by step. A tool call goes through the Tool System; a step that
   names an unoffered tool is refused.
5. **Synthesize** an answer from the tool results, delimited and labelled as
   untrusted evidence.
6. **Assess** completeness and record limitations.
7. **Report** status, the answer, provenance, usage and limitations.

Limits (defaults, with hard ceilings enforced server-side):

| Limit            | Default | Ceiling |
| ---------------- | ------- | ------- |
| Iterations       | 8       | 50      |
| Tool calls       | 8       | 50      |
| Wall clock       | 60 s    | 10 min  |
| Provider retries | 3       | 10      |
| Context chars    | 24 000  | 200 000 |
| Continuations    | 2       | 4       |

Exhaustion is reported as `limit_reached`, never as a successful answer. The run
also records which ceiling it spent (`limit: { kind, used, ceiling, reason }`) and
whether it may carry on (`canContinue`).

## Continuing a stopped run

A run that runs out of budget is not a failure and does not have to start over.
`POST /api/reasoning/runs/:runId/continue` gives it a fresh budget and resumes it:
the completed steps, the plan and the decisions are kept, so the model picks up
where it stopped instead of repeating work that already succeeded.

- Only a run in `limit_reached` can continue; anything else is
  `REASONING_RUN_NOT_CONTINUABLE` (409).
- The continuation count is capped by `maxContinuations` (default 2, ceiling 4).
  A cap of 0 makes the ceiling final. Past the cap the call is
  `REASONING_CONTINUATION_EXHAUSTED` (409) and the answer is to start a new run.
- Each continuation is recorded as a `run_continued` audit event and as a decision
  on the run, so the history shows that a second budget was granted rather than
  hiding it.
- In the chat, a stopped turn shows the budget it spent ("5 of 5 tool calls used")
  and a Continue control, not the connection-failure card.

## Provider disclosure

Every run carries:

```json
{ "providerId": "openai", "modelId": "gpt-…", "live": true, "simulated": false }
```

A simulated run reports `live: false`, `simulated: true`, and adds a limitation
saying no model was called. The page shows a "Simulated" badge next to the model.

## Human confirmations

When a tool needs approval the run pauses with `awaiting_confirmation` and a
`pendingConfirmation` block (tool, risk level, expiry). Nothing has executed at
that point. The decision is recorded by the Tool System, which enforces expiry and
input binding, and only then does the run continue. A rejection continues the run
without that call; it does not fail the whole run.

## Streaming

`GET /api/reasoning/runs/:runId/events` is a server-sent event stream of:

| Event            | Meaning                                        |
| ---------------- | ---------------------------------------------- |
| `phase`          | The pipeline moved to a phase                  |
| `provider`       | Which provider and model answered              |
| `classification` | Task type and whether tools are needed         |
| `plan`           | The validated plan                             |
| `delta`          | A chunk of the answer as it is produced        |
| `tool`           | A tool step started or finished                |
| `confirmation`   | The run is waiting for a decision              |
| `final`          | The finished run exactly as the API reports it |
| `usage`          | Iterations, tool calls, tokens and latency     |
| `error`          | A failure that ended the run                   |

Events are buffered per run (bounded), replay on reconnect via `Last-Event-ID`, and
stop when the run reaches a terminal status.

## API

| Route                                          | Purpose                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| `GET /api/reasoning`                           | Profiles, limits, provider state, tools on offer                     |
| `POST /api/reasoning/runs`                     | Start a run (`task`, `profile`, `mode`, `projectId`, `conversation`) |
| `GET /api/reasoning/runs/:runId`               | One run                                                              |
| `POST /api/reasoning/runs/:runId/cancel`       | Cancel a live run (a finished run is refused with 409)               |
| `POST /api/reasoning/runs/:runId/confirmation` | Record a decision, continue the run                                  |
| `GET /api/reasoning/runs/:runId/events`        | Server-sent events                                                   |
| `GET /api/reasoning/usage`                     | Recent usage records                                                 |

`mode` is `gateway` (default; requires a connected provider, otherwise 409) or
`simulated` (explicit opt-in, disclosed).

Cancellation is one-way and only applies to a run that has not finished: a
completed, failed or limit-reached run answers `REASONING_RUN_NOT_CANCELLABLE`
(409) and keeps its recorded answer. The stream's `final` event carries the
terminal run; the web client re-reads the run when it does not.

## Web page

`#/reasoning` shows the provider and model chips, a profile picker, the model
source, the prompt, a phase strip, the streamed answer, the tool steps, the budget
line, the tool list for the selected profile, and the confirmation card when a run
is waiting. Simulated runs are badged; failed runs show the error and no answer.

## Known limitations

- No hidden chain of thought is produced or stored, by design. The interface shows
  the plan, the tool steps and concise decisions instead.
- Jobs and runs are in-process. A restart loses run history (usage included).
- Streaming is replay-on-reconnect, not durable storage: a run older than the
  buffer only shows its final state.
- The owner header is a development stand-in for authentication.
- Context is passed explicitly by the caller today; automatic retrieval from
  project memory and the connected-app registry is not wired into a run yet.
- The simulated provider proves the loop, not model quality.
