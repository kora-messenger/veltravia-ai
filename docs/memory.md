# Project Memory (Step 15)

Project memory gives every Veltravia project a durable, curated set of
facts the platform can reuse across sessions and runs: the stack, the
testing rules, settled decisions, verified constraints. It is a memory of
**what is true**, not a transcript of what happened.

The full surface lives in `memory/core` (`@veltravia/memory-core`) with a
deterministic in-memory mock (`memory/mock`, `@veltravia/memory-mock`), and
is exposed through the API at `/api/projects/:projectId/memories…`.

## Principles

1. **Memory is reference data, never instructions.** Everything a model
   sees from memory enters the agent context through the Memory Context
   Builder, wrapped in a labeled block that declares itself UNTRUSTED
   reference data. Prompt injection in stored memory gains no authority.
2. **Humans own the memory.** Users create, edit, archive, verify, and
   delete memories through the API. AI-extracted candidates are
   NON-AUTHORITATIVE: they land as `candidate` records and only an
   explicit human approve promotes them to `active`.
3. **Small and honest.** Hard capacity limits (default 200 memories per
   project, configurable up to a ceiling), bounded content (4,000
   characters), bounded queries, bounded context. Every memory carries a
   provenance `source` (`user` or an extraction reference) and a
   `verificationStatus`.

## Lifecycle

- `active` — the only status that enters agent contexts.
- `archived` — retained for history, invisible to context and search.
- `candidate` — awaiting review; never injected into a run.
- `rejected` — reviewed and declined; never resurfaces.

Archiving and restoring are validated transitions; deletion is permanent.
`markVerified` stamps a human verification timestamp; `markStale` flags
content that may have drifted from reality.

## Extraction (candidates only)

Completed generation runs and completed testing runs can be distilled
into candidates through `POST /api/projects/:projectId/memories/extract`:

- **Generation runs** contribute a project summary (name, app type,
  template, idea) and, when tests ran, the testing command. The safe run
  view carries only bounded metadata — spec feature lists and generated
  code are deliberately not exposed to extraction.
- **Testing runs** contribute the detected stack (project type,
  framework, runtime), the configured test command, and ONLY the `FACT`
  statements of an approved diagnosis. Inference and recommendation
  statements never become memory.

Only `completed` runs extract (409 otherwise); runs from another project
are rejected; nothing extracts automatically — extraction is always an
explicit request, and its products always wait for a human decision.

## Context injection

When an agent run is created with a project association, the API derives
the memory context server-side:

1. Only `active` memories of that project are searched and ranked
   (confidence, verification, recency).
2. The bounded builder formats the top entries (bounded count and size)
   into one labeled block, stamped with provenance.
3. The block enters `AgentRequest.memoryContext`, validated like every
   other request surface (non-empty string, hard size cap,
   secret-shaped content rejected).

The browser never supplies or shapes memory content. Memory is an
ENHANCEMENT, never a gate: a memory failure can never fail an otherwise
valid run.

## Security rules

See [security.md](security.md) §5l for the enforceable boundary rules.
In short: secret-shaped content is rejected at every write surface;
responses are safe normalized views; the audit trail records lifecycle
events without content; the agent treats the memory block as UNTRUSTED
DATA exactly like tool results.
