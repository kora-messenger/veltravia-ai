# Frontend Builder UI (Step 32)

The builder is the workspace where a person turns an idea into real project files.
It is deliberately **three regions over systems that already exist**, not a fourth
system:

| Region     | What it is                                              | Backed by                                  |
| ---------- | ------------------------------------------------------- | ------------------------------------------ |
| Explorer   | Native project files: tree, folders, revisions, history | `@veltravia/source-storage-core` (Step 31) |
| Main       | Project overview and read-only file inspection          | source structure classifier (this step)    |
| AI builder | A conversation with the coding agent                    | `@veltravia/coding-agent-core` (Step 9)    |

Route: `#/projects/<projectId>/builder`. Entry points: **Open builder** on the
project detail page, and **Open in frontend builder** right after a scaffold plan
is materialized on `#/builder`.

## What this step adds

1. **Framework-aware frontend structure** (`classifyFrontendStructure` in
   `app-builder/core/src/frontend/structure.ts`). Files are grouped into pages,
   components, layouts, hooks, styles, assets and utilities from their **paths
   only** - no file contents travel to classify, and no framework is assumed.
   `GET /api/projects/:projectId/source/structure` runs it over the real tree and,
   when the stack detector recognises a framework, reports that framework id.
   When detection finds nothing the answer is `framework: null` plus neutral
   grouping, rather than a React guess.
2. **Coding capability reporting** (`GET /api/coding/capabilities`). The API's
   default coding agent runs a scripted decision source, so the UI says
   "scripted demo agent" and explains that the plan may not match the wording.
   The approval gate, revision checks and writes are still real.
3. **Plans are reviewable before approval.** `CodingRunView.plan` now exposes the
   validated plan (goal, steps, files to inspect, files to modify, validations),
   so the approval card shows what will happen instead of asking for blind trust.
4. **The builder workspace page** (`apps/web/src/pages/builder/`).

## Interaction contract

- A request **starts a coding run**. Nothing is written by the page; the agent
  writes through the Tool System with the plan gate and `expectedRevision`
  protection intact.
- The plan card appears while the run is `awaiting_approval`. Approve continues the
  run; **Reject** ends it. Decisions are sent once and the server's response is
  authoritative - the page re-reads the run if a decision request fails.
- File changes are reported **after** a run completes, from the run's own
  `changedFiles`, cross-referenced with file history for created/modified/deleted.
- Cancelling is a one-way request; the terminal state comes from the server.
- One run at a time per workspace. Switching project abandons the previous run.

## States

| Surface   | Loading     | Empty                              | Error                                 |
| --------- | ----------- | ---------------------------------- | ------------------------------------- |
| Page      | spinner     | no project selected                | "Could not open this project" + retry |
| Explorer  | note        | "This project has no files yet"    | inline error with retry               |
| Main      | —           | "no files classified as pages yet" | structure error note                  |
| File view | spinner     | —                                  | "Could not read this file"            |
| AI panel  | run spinner | example requests                   | run error text; failed run message    |

## Read-only by design

There is **no editor in this release**. Selecting a file shows its content with the
revision, size and a truncated marker, and says plainly that editing happens
through the AI builder. File contents are rendered as text in a `<pre>`; they are
data, never instructions.

## Responsive behaviour

- `> 1100px`: three columns (explorer / main / AI), explorer and AI panels sticky.
- `1100px - 900px`: explorer + main side by side, AI panel below.
- `< 900px`: single panel with header tabs (Files / Builder / AI chat). Only the
  selected region is displayed.

## Limits (honest)

- No branches, no merge UI, no full editor - planned, not built.
- The structure classifier is heuristic: it reads paths, so unusual layouts land in
  utilities rather than pages.
- The default API agent is a scripted demo; a real model produces different plans.
- Runs are in-process: restarting the API loses run history (files persist).
