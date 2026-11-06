# Source-code export (Step 40, phase 2)

Download a project's source code as a ZIP. It works on its own: GitHub is not
involved, and no GitHub account or token is needed.

## What it does

- **Whole project or a selection.** Export everything, or choose files and
  folders. A folder covers its children; naming a file and its folder does not
  duplicate the file.
- **Files are byte for byte.** Contents are written to the archive exactly as
  stored: no reformatting, no newline changes, no trimming. Line endings
  (CRLF), trailing spaces and non-ASCII text survive. The archive has one root
  folder named after the project.
- **Any language.** Export is by file, not by framework, so source, manifests,
  lockfiles, Dockerfiles and docs all travel the same way.
- **Reproducible.** Timestamps in the archive are fixed, so the same project
  revision always produces the same bytes and the same SHA-256.
- **Read only.** An export never writes to the project. The revision of the
  project is the same before and after.

## Where it lives

| Part   | Location                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------ |
| Engine | `export/core` (`@veltravia/export-core`): paths, secret scanner, consistent reader, ZIP builder, manager     |
| API    | `apps/api/src/routes/exports.ts`, `export-service.ts`, `rate-limit.ts`                                       |
| Page   | `#/projects/<id>/export` (`apps/web/src/pages/export`), opened from "Export source code" on the project page |

It reads through the same project engine as every other feature. There is no
second project store.

## API

All routes use the same caller resolution as the rest of the API
(`x-veltravia-owner-ref`, else the development owner). There is no second sign-in.

| Route                                   | Purpose                                                                                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/projects/:projectId/exports` | Create. Body `{}` / `{"scope":"project"}`, or `{"scope":"selection","paths":[...]}`. `201` when ready; `200` with `status: failed` and a reason when it could not complete |
| `GET /api/exports`                      | The caller's exports (optionally `?projectId=`)                                                                                                                            |
| `GET /api/exports/:id`                  | Status                                                                                                                                                                     |
| `GET /api/exports/:id/validate`         | Re-opens the stored archive and checks every entry against the export's own record                                                                                         |
| `GET /api/exports/:id/download`         | The ZIP: `attachment`, `nosniff`, `no-store`, with `x-veltravia-archive-sha256`                                                                                            |
| `DELETE /api/exports/:id`               | Discard the export and free its bytes                                                                                                                                      |

A request body is checked before Fastify can coerce it: a string where an array
belongs, numbers in `paths`, or `paths` without `scope: "selection"` (which
would otherwise export the whole project) are all refused with 400.

## Security

- **Ownership on every call.** A project or export that is missing, deleted or
  someone else's gives the identical `404`, so ids cannot be probed. The central
  project guard answers before the body is read; the manager checks again.
  Another owner cannot create, read, validate, download, delete or list.
- **Unguessable ids.** Export ids carry 144 bits of randomness.
- **Paths.** Rejected: `..`, absolute paths, drive letters, backslashes,
  control characters, empty segments, `.` segments, and percent-encoded
  separators (a path is a literal name, never decoded). The archive builder
  checks every entry name again, so it is safe whatever fed it.
- **Credential files are left out by name:** `.env`, `.env.*`, `*.env`,
  `.envrc`, `.npmrc`, `.netrc`, `.pypirc`, `.git-credentials`, `.htpasswd`,
  `id_rsa` and friends, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, service
  account and secrets JSON/YAML, `terraform.tfvars`. Template files such as
  `.env.example` are kept, because they document variable names.
- **Secrets are left out by content.** Every file is scanned line by line with
  21 token shapes (GitHub, OpenAI-style, OpenRouter, Groq, Anthropic, Google,
  AWS, Slack, Stripe, Twilio, npm, SendGrid, bearer and JSON web tokens, private
  key blocks, passwords inside URLs) plus long literals assigned to secret-looking
  names, plus the shared project-engine detector. Environment lookups,
  placeholders, types and short values are not flagged. A name does not clear
  content: a `.env.example` that holds a real key is excluded.
- **Reported without revealing.** An exclusion is a path, a fixed reason and one
  sentence naming the _kind_ of secret. The matched text and its position are
  never kept, so they cannot reach a log, an error, a response or the page.
- **Never the platform's own credentials.** Export only reads the project's
  workspace tree; provider keys live in the vault and are not in that tree.
- **Limits.** 2,000 files; 512 KB per file; 32 MB of source and of archive; 100
  paths in a selection; 10 archives per owner (oldest dropped); creation limited
  to 20 per minute and downloads to 60 per minute per caller (`429` with
  `Retry-After`).
- **Temporary data.** Archives are held in memory for 15 minutes, then removed.
  Deleting an export frees its bytes at once. A failed export leaves no archive.
- **Errors say nothing extra.** An unexpected failure becomes "The export could
  not be completed." and never echoes a path, message or content.

## One revision, never a mixture

The reader takes the workspace revision, lists the tree, reads every file, then
checks that the revision and every file's own revision are unchanged and that
no file was added or removed. If anything moved, the read is thrown away and
repeated. After 3 read attempts it stops with `EXPORT_REVISION_CONFLICT` and
builds no archive. The result records the revision it read. Files from two
revisions are never combined.

## Storage and persistence

Projects and archives are in memory today. An API restart loses both, so an
export that is not downloaded in time is gone and must be run again. The engine
does not assume this: it needs only four reads from a project (`resolveProject`,
`listNodes`, `workspaceRevision`, `readFile`) and an `ArchiveStore` with
`put/get/delete`. A PostgreSQL project store and an object-storage archive
store can replace them without changing the engine, routes or page. That
migration is not part of this phase.

## The page

Two regions on a wide screen (what to export; the result), one below 900px.
Loading, empty project, load error with retry, selection with a locked-children
rule, progress, ready (files, sizes, revision, SHA-256, minutes left), failed
(with advice, for example "nothing was saved" for a conflict), expired, and a
list of what was left out with reasons. The browser re-hashes the download and
compares it with the recorded checksum; a mismatch is refused and nothing is
saved.

## Known gaps

- **No symbolic links, binary files or empty directories.** The project store
  holds text files only (512 KB each), so there is nothing to follow and nothing
  to preserve. Empty folders are not recorded in the archive.
- **The secret check is a safeguard, not a guarantee.** It reduces the chance
  of shipping a key; it cannot prove a file is clean. A secret in an unusual
  format, split across lines, or encoded will not be found. Review before you
  share.
- **A name is judged, not its meaning.** A file called `credentials.json` is
  excluded even if it holds nothing secret.
- **A race cannot be provoked in memory.** In this storage a whole read finishes
  between writes, so the conflict path is proved by tests that change the project
  inside a read, and a live concurrent-writer run produced consistent archives
  with no retries. A database store is where it will matter.
- **Rate limits are per process.** Behind several API instances each counts alone.
- **Sign-in is the development stand-in.** The owner header is not real
  authentication, and the web app sends none, so it acts as the development owner.
- **GitHub sync is not here.** It is the next phase and this one does not depend on it.
- **Direct workspace writes bypass source rules.** The project-engine file route
  accepted a `.env` and a key in code during live testing (the source API rejects
  them). Export is the line of defence for those files, which is why it excludes
  by name and by content rather than trusting storage.

## Verified

3,857 tests pass across the repository, 153 of them new: 28 for the secret
scanner, 50 for the engine, 20 for the API, 20 for the web client, 9 for the
page's wording and selection rules, 21 for the page and 5 for its state hook.
The consistency tests were checked by switching the revision checks off, which
fails exactly those four; the double-start guard test fails with the guard
removed.

Live, against a running API with two owners: the export of a multi-language
project excluded all four planted secrets with the right reasons; the archive
passed `zipfile.testzip` (a third implementation, besides `fflate` and `yauzl`);
five sample files matched byte for byte, including CRLF and non-ASCII text; none
of the planted secrets was in the archive; and the recomputed SHA-256 equalled
the recorded one. Another owner got the same 404 as for a missing project on
every route, and 6 traversal forms gave 400. Archives made while a writer
rewrote a file 3,000 times validated clean, each holding one coherent version.

In the browser: 44 of 44 checks on desktop (1280) and mobile (390), including a
real download whose hash equalled the one on the page, and 15 of 15 for the
empty, missing, rate-limited, failing, conflicting, offline, tampered and deleted
states.

Defects found while testing, all fixed: the engine lost the excluded list when
every file was excluded (an engine test); `paths` without `scope` would have
exported the whole project, and a string or numbers were coerced into a valid
selection (an API test); radio buttons were 13px wide (browser measurement).
