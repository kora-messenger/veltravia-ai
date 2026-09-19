# Codebase Intelligence (Step 16)

Codebase intelligence gives Veltravia a structural understanding of a
workspace's source: what languages and frameworks are present, which files
are entry points or components, how files import and symbols reference each
other, and where a feature lives. It is **analysis of what is there**, not a
copy of the code: indexes store symbols, relationships, and evidence —
never file contents, never values.

The engine lives in `codebase/core` (`@veltravia/codebase-core`) with a
deterministic in-memory mock (`codebase/mock`,
`@veltravia/codebase-mock`), and is exposed through the API at
`/api/projects/:projectId/codebase…`.

## Principles

1. **Indexes are metadata, never content.** A build reads source through
   the `CodebaseSourceProvider` port (a read of already-authorized project
   files), derives symbols, relationships, and summaries, then stores only
   the structural conclusions. File content, symbol bodies, and values are
   never retained in the index.
2. **Secret-shaped values are flagged, never stored.** Files that look like
   they contain credentials are counted and flagged by path (`parseStatus`
   plus `flaggedSecrets`); the suspected values are never read into the
   index, shown in the UI, or written anywhere.
3. **Bounded by construction.** Hard limits (default ceilings: 2,000
   indexed files, 400 symbols per file, 20,000 symbols, 30,000
   relationships, 1 MB per source file, 60 s per build, 50 search results,
   trace depth 6 / 120 nodes) are enforced server-side; every response is
   truncated to its limit with an honest `truncated` marker.
4. **Evidence, not inference.** Search results, references, and feature
   traces always carry the file path and a short evidence line so a human
   can verify why something matched. Evidence text is scrubbed so
   secret-shaped characters cannot ride along.

## What a build produces

- **Languages & frameworks** — detected from evidence (imports,
  dependencies, config), each with a confidence, never guessed from names
  alone.
- **Symbols** — functions, classes, components, and other declarations with
  kinds and locations; parsing failures are honest per-file `failed` /
  `unsupported` statuses, never silent skips.
- **Relationships** — file-level imports and symbol-level references
  (imports of named exports, callers, callees), built only from evidence
  that appears in the source.
- **Entry points, routes, components** — structural classifications from
  the parsed sources.
- **Index state** — revision-tracked, incremental rebuilds reuse unchanged
  files (hash comparison), and `current` / `stale` status is computed
  against workspace revision so the UI can offer an honest refresh.

## Tools

Eight read-only tools ride the Step 5 Tool System, all requiring the
`codebase.read` permission, none requiring confirmation (analysis only,
no mutation): `codebase.search`, `codebase.find_symbol`,
`codebase.find_references`, `codebase.find_callers`, `codebase.find_callees`,
`codebase.trace_feature`, `codebase.get_summary`, and
`codebase.get_file_symbols`. Agents reach codebase knowledge only through
this pipeline — there is no direct access path around the Tool System.

## Memory candidates

`POST /api/projects/:projectId/codebase/memory-candidates` derives a small
set of durable structural facts (technology profile, entry points, test
files, route/component counts) from a **completed** index build and hands
them to project memory as **candidates** — provenance `system_derived`
with the index id as reference. The full index is deliberately NOT
duplicated into memory, and nothing auto-promotes: a human approves or
rejects every candidate through the memory panel (see
[docs/memory.md](docs/memory.md)).

## API surface

`GET …/codebase/index` (current index view), `POST …/codebase/index`
(build / incremental refresh), `POST …/codebase/search`, `POST
…/codebase/trace`, `GET …/codebase/summary`, `GET …/codebase/files/*`
(symbol view for one file), `GET …/codebase/symbols/:symbolId`, and `POST
…/codebase/memory-candidates`. Responses are safe normalized views (paths,
counts, statuses, bounded evidence); typed scrubbed errors map to exact
HTTP codes.

## Web workspace

The workspace's **Codebase analysis** panel (desktop side panel and mobile
drawer) renders the index status, derived stats, language/framework
profile, flagged-secret counts, bounded symbol search, feature tracing,
and the memory-candidate extraction action. Source content is never shown
in the panel — the file tree remains the content pathway.
