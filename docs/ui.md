# Web UI (Steps 11A + 11B + 11C-1 … 11C-5: live AI workspace with real project context)

The `apps/web` package hosts the Veltravia AI product UI. Step 11A
establishes the design system, the reusable component library, the
light/dark theme architecture, and the application shell. No feature
screens exist yet — the shell routes to clearly-marked placeholder pages.

## Design system

| Concern       | Location                            |
| ------------- | ----------------------------------- |
| Design tokens | `apps/web/src/design/tokens.css`    |
| Base styles   | `apps/web/src/design/global.css`    |
| Component CSS | `apps/web/src/components/ui/ui.css` |
| Shell CSS     | `apps/web/src/shell/shell.css`      |

All colors, spacing, radii, shadows, typography, and motion are defined as
CSS custom properties in `tokens.css`. Components never hardcode raw color
values; everything flows through the semantic tokens (`--v-primary`,
`--v-surface`, `--v-border`, …). The palette is a distinctive
violet-indigo brand over a cool-neutral scale.

### Tokens

- **Typography** — system font stacks (no external font service): sans
  (`--v-font-sans`) and mono (`--v-font-mono`); utility classes `.v-display`,
  `.v-heading-1/2/3`, `.v-body`, `.v-label`, `.v-caption`, `.v-mono`.
- **Spacing** — `--v-space-05` … `--v-space-8` (2px–64px).
- **Radius** — restrained: `--v-radius-xs/sm/md/lg` plus `--v-radius-full`.
- **Shadows** — three subtle elevation levels (`--v-shadow-1/2/3`).
- **Borders** — `--v-border`, `--v-border-strong`, `--v-border-muted`.
- **Motion** — `--v-dur-fast/base/slow` with `--v-ease-out`; hover, focus,
  open/close, and state transitions only. `prefers-reduced-motion: reduce`
  disables all animation.

## Theme architecture

`apps/web/src/theme/ThemeProvider.tsx` owns theming:

- The user preference is `light` | `dark` | `system` (default `system`),
  persisted in `localStorage` under `veltravia.theme-preference`.
- The provider resolves `system` against `prefers-color-scheme` and follows
  OS changes live while the preference stays `system`.
- The resolved theme is applied as `data-theme` on `<html>`; all styling
  reacts through CSS custom properties, so future theme customization
  (more themes, user accents) extends the token layer without a rewrite.

## Component library

`apps/web/src/components/ui/` exports primitives from a single barrel
(`index.ts`): Button, IconButton, Input, Textarea, Select, Checkbox,
Switch, Badge, Card, Tooltip, Dialog, Menu, Tabs, ToastProvider/useToast,
Spinner, EmptyState, ErrorState, StatusIndicator, Divider.

Every interactive component ships with accessible labels, keyboard
support, visible focus states, disabled states, and (where applicable)
loading and error states. Dialogs trap focus, close on Escape, and restore
focus; menus support arrow/Home/End navigation; tabs use the roving-tabindex
pattern; toasts announce through a polite live region.

## Application shell

`apps/web/src/shell/`:

- `AppShell.tsx` — sidebar + top bar + main content area.
- `Sidebar.tsx` — primary navigation (Dashboard, Projects, Settings) with
  active (`aria-current="page"`), hover, focus, and collapse states.
- `TopBar.tsx` — single-strip bar: brand mark, page context title, mobile
  navigation trigger, account menu (theme cycling; account/sign-out are
  explicitly disabled until authentication exists).
  Geometry is taken from the supplied reference bar (390px capture): 56px
  tall, 12px left padding, 14px right padding, 22px brand mark, 18px/500
  title, 20px action glyphs with 32px hit areas. The bar paints on the
  raised surface rather than the page background so it reads as its own
  strip. The premium slot is a reserved 20px gap that draws nothing: the
  crown returns when there is a real subscription behind it, and until then
  the bar carries no decorative status mark. Verified in-browser at 390px and
  1280px (bar height 56px, title 18px/500, no horizontal overflow).
  It is drawn at 22px with a 1.6 stroke (the shell default is a 16px icon),
  so it reads as dark as the title rather than as a thin outline.
  The account control is the reference glyph redrawn inline: a document with
  three ruled lines in the upper right and a monitor standing in front of its
  lower-left corner. The monitor is stamped twice, once in the bar's surface
  colour, so the corner reads as behind it rather than as crossing strokes;
  that knockout follows the theme because it uses the surface token.
  Tapping it opens a small right-aligned card (11rem minimum, 14px rows, 18px
  glyphs) with exactly two rows, as the reference shows: Notes and Computer.
  Neither surface exists in this release, so both rows are disabled and carry a
  muted "Soon" note instead of pretending to work; wiring one is a line of
  `onSelect` plus removing `disabled`. Disabled rows keep full contrast (20px
  glyph, `--v-text`), because the reference popup is solid black; the Soon note
  and the not-allowed cursor carry the unavailable state. The card opens over the control that
  opened it (its top edge sits on the icon, not below it), so Escape and a tap
  outside are the ways out: Escape is handled at the document because focus
  stays on the trigger. Removing these rows also removed the
  theme control from the UI (it lived in that menu), so the app now follows
  the operating system's preference until a theme control is placed elsewhere.
- `useHashRoute.ts` — minimal hash routing (`#/dashboard`, `#/projects`,
  `#/projects/<id>`, `#/settings`); unknown hashes fall back to the
  dashboard. `RouteState` carries route parameters (e.g. the project id)
  to page components; `navigateToHash` drives programmatic navigation.
  The project-detail route highlights the Projects navigation item.

Responsive behavior is deliberate, not a shrink: below 900px the sidebar
becomes an overlay drawer (backdrop + Escape close), the top bar gains a
navigation trigger, and content padding compresses.

## UI security boundary

The web app is a rendering surface only:

1. No credential material (tokens, API keys, secrets, private keys) may
   live in React state, localStorage, sessionStorage, source, HTML, URL
   parameters, or browser-visible API responses. localStorage holds exactly
   two things: the theme preference, and the browser's saved conversations
   (a title, the turns, a timestamp — no credentials, no run records).
2. Future integrations render credential REFERENCES and connection status
   (`StatusIndicator`/`Badge`), never raw credentials.
3. Unimplemented backend features are rendered as clearly-unavailable UI
   (disabled menu items, placeholder pages) — the UI never fabricates
   success.

## Testing

UI tests colocate with sources (`*.test.tsx`, jsdom environment via a
per-file `@vitest-environment jsdom` pragma) and cover the shell
(navigation, active state, collapse, drawer, routing with parameters),
theme behavior, and component states (disabled, loading, error, keyboard,
ARIA wiring). Page tests mock the `api/` modules and assert loading,
ready, empty, error+retry, and dialog flows end to end.

## Web API client (Step 11B)

`apps/web/src/api/` is the single network seam:

- `client.ts` — `apiRequest()` wraps `fetch` (injected for tests), sends
  JSON bodies, and normalizes every failure into a typed `ApiError`
  (`status`, `code`, scrubbed `message`). Network failures become code
  `NETWORK` with a friendly message; error internals/stacks never reach
  the screen.
- `projects.ts` / `workspaces.ts` — typed calls over the Project Engine
  routes. Responses are validated and mapped to safe VIEW MODELS:
  engine-internal fields (`metadata`, `ownerRef`, logical `root`) are
  dropped before anything reaches React state. `updateProject` always
  sends `expectedRevision` (revision safety).
- `use-async-resource.ts` — one `useAsyncResource(loadFn, deps)` hook
  powering loading / ready / error(+retry) states; no ad-hoc fetch logic
  in components.

In development, Vite proxies `/api/*` to the local API service
(`VELTRAVIA_API_PROXY_TARGET`, default `http://localhost:3000`) so the
browser sees same-origin requests.

## Project pages (Step 11B)

`apps/web/src/pages/` (styles in `pages.css`, all colors/spacing from the
design tokens):

- **Dashboard** — project overview (totals, active/archived), a
  recently-updated grid, create-project entry point, and the same
  empty/error states as the Projects page.
- **Projects** — the full project list with status filters
  (All / Active / Archived), open/archive/restore actions.
- **Project detail** (`#/projects/<id>`) — identity, status, type,
  timestamps, a workspace overview, edit details, archive/restore, and
  workspace creation (blocked while the project is archived).
- Dialogs (`pages/projects/`) — create project, edit details,
  confirm-driven archive/restore, create workspace. All archive/restore
  actions run through an explicit confirmation; a stale-revision write
  (HTTP 409 `REVISION_CONFLICT`) is surfaced as a conflict message and the
  latest server state is reloaded — the UI never silently overwrites.

Forms validate client-side (required name, length caps) and surface
server errors inline; submit buttons show loading state and cancel is
disabled while a request is in flight.

Settings remains an honest placeholder until its dedicated roadmap step;
no future feature is presented as functional.

## AI Workspace shell (Step 11C-1)

`#/projects/<id>/workspace` — the visual shell for working with one
project through Veltravia AI. **This checkpoint is UI/UX only**: the
layout, conversation surface, composer, and activity panels exist and are
architecturally ready, but no live AI interaction happens yet. Nothing in
the workspace simulates a response, a tool call, a run, or a file
operation. Live agent, tool, and file-tree wiring arrive in later
checkpoints.

### Structure

Three regions on desktop (grid, from `pages/workspace/workspace.css`):

1. **Project context** (left) — the project's identity/status, the
   workspace identity where one exists, and a file-tree illustration that
   is explicitly labeled as not-live until the Project Engine file tree is
   wired in.
2. **AI workspace** (center) — the conversation area (Veltravia
   introduction when empty) above the message composer. The composer is
   multiline, keyboard-driven (Enter sends, Shift+Enter breaks the line),
   and transmits nothing: submitted text is only echoed locally with an
   honest note that AI replies arrive in a later release.
3. **Activity** (right) — agent activity and tool activity sections.
   Both render honest empty states; the visual vocabulary for future
   statuses (queued, running, awaiting confirmation, completed, failed,
   cancelled), risk levels, and confirmation requirements exists but is
   only ever driven by real data.

The workspace has its own header bar (project name, status, a way back
to the project page, and — on small screens — drawer triggers); global
branding and account controls remain in the Step 11A shell top bar.

### Responsive strategy

- Desktop (>1200px): three persistent regions.
- Tablet (900–1200px): three narrower regions.
- Mobile (<900px): a single deliberate column (conversation + composer).
  The side panels move into accessible drawers (`WorkspaceDrawer`):
  backdrop + Escape close, focus moves into the drawer and returns to the
  trigger on close.

### Trust visual language

Every conversation message carries an explicit origin so users can tell
who produced what: user content (brand-tinted), assistant content
(raised surface, "Veltravia AI" label), system status (quiet centered
line), and tool output (bordered data card with a "Tool output" label
and source caption). Tool output is always rendered as data — plain
React text nodes, never HTML, never executed.

### Component organization

`apps/web/src/pages/workspace/`:

- `message-model.ts` — safe view models (`WorkspaceMessageView`,
  `ActivityEntryView`) that future checkpoints will map live API
  responses into.
- `ProjectContextPanel`, `ConversationArea`, `MessageComposer`,
  `ActivityPanel`, `WorkspaceDrawer`, `WorkspaceHeader` — composed by
  `pages/ProjectWorkspacePage.tsx`.

Only the existing API client surface is used: the project and workspace
reads that identify the current project. No AI, agent, coding-agent,
tool, sandbox, or GitHub API is called from the workspace.

## AI Workspace live interaction (Step 11C-2)

The workspace at `#/projects/<id>/workspace` is now a real client for the
existing Agent API (Step 6). The 11C-1 shell is unchanged structurally; the
composer is wired to real runs.

### Workspace → Agent API flow

1. The page loads the project, its workspaces, and the agent list
   (`GET /api/agents`). It selects the direct-answer agent when present,
   otherwise the first agent the API offers (a documented development
   limitation: the available agents are scripted demo agents until a real
   model is wired in).
2. Submitting the composer appends the user's message and calls
   `POST /api/agents/run` with `{ agentId, task, projectId }` — no user
   identity is invented or sent.
3. The backend executes the run within the request, so the response usually
   already carries the terminal state. `awaiting_tool` responses are followed
   with bounded polling (`GET /api/agents/runs/:runId`, ~0.9s interval,
   hard attempt ceiling, consecutive-failure ceiling). Polling never
   overlaps itself, always stops on terminal/paused states, and its timer is
   cleared on unmount.
4. Cancellation is a single `POST /api/agents/runs/:runId/cancel` per run,
   shown only while a run is live, and the UI claims "cancelled" only after
   the server's response says so. A failed cancel keeps the run's real state
   and shows a recoverable note.
5. On `completed`, the run's `finalOutput` is appended as the assistant
   message. Failed, cancelled, and limit-reached runs append an honest system
   note; nothing is ever fabricated. "Try again" starts a NEW run with the
   same prompt (never a replay).

### Run lifecycle mapping

Backend statuses map to explicit UI phases: `creating` (run request in
flight) → `running` (incl. `awaiting_tool`) → `paused`
(`awaiting_confirmation` — honest notice, no confirmation controls yet) →
`completed` / `failed` / `cancelled` / `limit-reached`. The UI never shows
"completed" unless the backend reported it.

### Multiple-run protection

One active run per workspace conversation: the composer is disabled while a
run is active, double submission is rejected, and every in-flight operation
carries a generation token — responses from a superseded run (including a
mismatched run id) are discarded and can never overwrite a newer run.

### Frontend credential boundary

The browser talks ONLY to the Veltravia API. No provider SDK, provider
endpoint, or credential literal exists anywhere in `apps/web` source, the web
app reads no environment variables, model output is rendered as plain React
text nodes (never HTML, never executed), and the only persisted local value
is the theme preference. These rules are enforced by tests
(`apps/web/src/security/workspace-boundary.test.ts`).

## Human confirmations and tool activity (Step 11C-3)

The live workspace now surfaces the agent's tool lifecycle and collects
human decisions — always with the server as the sole authority:

- **Confirmation card.** When a run pauses on `awaiting_confirmation`, a card
  in the conversation area names the tool (`mock.purge` in the demo), shows
  the risk level the Tool System reported, and offers exactly two choices:
  approve or reject. It renders only server-reported metadata — never the
  requested tool input. The decision is delivered to
  `POST /api/agents/runs/:id/confirmation`; the UI then shows whatever run
  state the server confirms. An expired request is terminal: the card says
  it can no longer be approved and offers no live buttons. At most one
  decision is in flight per run; a failed delivery keeps the run at its last
  server-confirmed state, shows an honest note, and resyncs once.
- **Tool activity.** The activity panel's tool section lists only recorded
  tool invocations (in the backend's order) plus the pending confirmation
  when one is reported. Success output is UNTRUSTED DATA: rendered as
  bounded plain text with an honest truncation note. Denied and failed
  invocations show their status and the server's message — the UI invents
  no tool calls, results, or statuses.
- **Run activity.** The agent section maps each run phase to exactly one
  honest entry (starting, working, waiting for your decision, finished,
  failed, cancelled, stopped at a safety limit).
- **Paused-run following.** A paused run is still followed on a slow
  cadence so a server-side expiry or state change is reported — while the
  fast cadence never spins on a run that cannot progress alone.

The browser remains a pure presentation client: no decision logic, no
provider/tool/sandbox calls, no credentials, and the requested tool input
never leaves the server (test-enforced in
`apps/web/src/security/workspace-boundary.test.ts`).

## Real project/workspace context (Step 11C-4)

The workspace's context panel is now LIVE, backed by the Project Engine
through the Agent API:

- **Run association.** Every run request carries the routed `projectId`
  and the selected `workspaceId`. The association is validated
  SERVER-SIDE: an unknown project or workspace is a 404, and a workspace
  from another project is rejected (400) — the browser's identifiers are
  never trusted. A run started before a workspace switch keeps its
  original ids; only new runs use the new selection.
- **Derived context.** The API derives a bounded, safe context for each
  run: project/workspace metadata (no owner ref, no root) plus structural
  file-tree information (relative path + node type). File CONTENTS are
  never part of the context. Large trees are truncated with honest
  `total`/`included`/`truncated` flags, and the whole context always fits
  the agent request's serialized-size budget. The context travels as an
  explicit `project_context` UNTRUSTED DATA block — project text is never
  concatenated into the trusted system prompt and never gains authority
  (prompt-injection defense, test-enforced).
- **Context panel.** Live project metadata, the selected workspace, and
  the workspace's real file tree (from `GET /api/workspaces/:id/tree` —
  structural metadata only, read-only: no editing, renaming, adding,
  deleting, uploading, or drag/drop). Projects with several workspaces
  get a picker; switching changes the context for NEW runs and the
  displayed tree. Loading, empty, and error states are all honest.
- **Boundary.** The web source never calls file-content endpoints or
  mutates the file tree (test-enforced in
  `apps/web/src/security/workspace-boundary.test.ts`). The browser
  displays structure the server already validated; it never constructs,
  normalizes, or re-sends paths of its own.

## Workspace polish + regression hardening (Step 11C-5)

The final sub-step of the AI Workspace UI phase. No new capability was
introduced — this pass audited the complete 11C-1…11C-4 surface and fixed
correctness, consistency, accessibility, and responsive issues found
during the audit:

- **Broken token references.** Three `font-weight: var(--weight-semibold)`
  rules in `workspace.css` pointed at a token that does not exist
  (`--v-weight-semibold` is the real one) and silently did nothing —
  fixed. The intro logo's hardcoded `#ffffff` now uses the semantic
  `--v-primary-fg` (correct in dark mode). Dead CSS (an unused
  file-tree depth class, a duplicated drawer rule) was removed.
- **Stale copy.** The paused-run strip claimed "Confirmation controls
  are not part of this workspace release yet" — false since 11C-3. It
  now points at the real approval card below it. Stale Step 11C-1/2
  "structure only / not wired yet" comments were updated to match the
  live workspace.
- **Announcements.** The conversation list is a `role="log"` polite
  live region: appended user/assistant/system messages are announced
  to assistive tech WITHOUT stealing focus from the composer. The
  center column carries `aria-busy` while a run is active.
- **Honest error records.** When a run cannot even be created (network
  failure), the conversation now keeps a SYSTEM note with the safe
  failure text (unique per retry, monotonic ids), so the record
  survives after the status strip is replaced. As everywhere, the text
  is safe client-side copy; nothing is fabricated.
- **Layout & responsive.** The run-status strip is centered with the
  conversation column (it previously hugged the right edge). Long file
  paths in the structure-only tree and long tool results wrap
  (`overflow-wrap: anywhere`) instead of overflowing. Confirmation
  action buttons wrap on narrow viewports. The workspace header's
  project name is a real `<h2>` (heading hierarchy: shell `<h1>` →
  workspace `<h2>` → panel `<h3>`s), with UA margins reset.
- **Empty mobile drawers (real bug).** The ≤900px media query hid
  `.v-context-panel` / `.v-activity-panel` unconditionally — including
  the DRAWERS' copies of those panels, so the mobile context/activity
  drawers opened empty. The hide is now scoped to the desktop grid
  children (`.v-workspace__body > …`), and the drawer copies sit flat
  (no double padding/background).
- **No regression in the trust boundaries.** No data flow changed: the
  same endpoints, the same server-authoritative states, the same
  untrusted-data treatment (see `docs/security.md` §5h rules 18–22).

Real-time streaming updates may be introduced in a later infrastructure
phase; the current implementation remains bounded polling.

## Integrations page (Step 12)

`#/integrations` — the user-facing integration catalog, backed by
`GET /api/integrations` and rendered from strict view models
(`src/api/integrations.ts`).

- **Catalog cards**: each integration renders its name, description,
  category/version/enabled badges, its declared scope catalog (with risk
  levels, as text — never color-only), its tool catalog (with confirmation
  requirements), and the owner's connections.
- **Connections**: status, account ref, granted scopes, and last status
  check render as metadata only. Actions — disable/enable, status check,
  disconnect — go through the real API endpoints; server rejections surface
  as inline typed errors, never fabricated success, and the list reloads
  from the server after any change.
- **Connect dialog**: scope checkboxes are generated ONLY from the
  integration's declared catalog; at least one explicit grant is required,
  and an optional account-ref label is offered. No credential field exists
  — credential material never enters the browser (test-enforced via the
  existing boundary scans).
- **Honest states**: loading, empty, and error states follow the shared
  patterns (`v-loading`, `v-empty-wide`, `ErrorState` with retry); a
  disabled integration renders a disabled Connect button rather than a
  fabricated action.

No new persistence: the page stores nothing beyond the theme preference
rule that applies app-wide.

## Project memory panel (Step 15)

The AI workspace gains a third side surface: `MemoryPanel`
(`src/pages/workspace/MemoryPanel.tsx`), rendered in the left region
below the project context on desktop and inside its own accessible
drawer (`WorkspaceDrawer`, header button "Memory") below 900px.

- **What it shows**: the live memory stats (active / candidate /
  archived counts), status-filtered lists (Active, Candidates,
  Archived), and each record's safe normalized view — type, confidence,
  verification state (Unverified / Verified / Stale), provenance
  ("Added by you" vs "From generation run (…)"), and content.
- **What the user can do**: search active memories, add a memory
  (title/type/content; secrets are rejected server-side), verify or
  stale a record, archive/restore, delete, and — for candidates —
  explicit Approve/Reject. Approve is the ONLY way a candidate enters
  AI context; candidates never expose lifecycle actions.
- **Honest states**: loading, per-filter empty states, inline typed
  errors with retry, and server-confirmed reloads after every action.
  Failures never fabricate memory.
- **Trust boundary**: the panel talks only to
  `src/api/memories.ts` (safe views); it never sends memory content
  the server did not produce, and candidate content arrives from the
  server's own extraction pipeline.

## Codebase analysis panel (Step 16)

The AI workspace gains a fourth side surface: `CodebasePanel`
(`src/pages/workspace/CodebasePanel.tsx`), rendered below the memory panel
in the left region on desktop and inside its own accessible drawer
(`WorkspaceDrawer`, header button "Codebase") below 900px.

- **What it shows**: index status (Current / Stale badge), the derived
  stats (files, symbols, routes, components), the language/framework
  profile, and an honest count of files flagged for secret-shaped content
  — values are never shown, only the count and the flag. A collapsible
  file list shows each file's parse status (`parsed` / `failed` /
  `unsupported`), never the source.
- **What the user can do**: build or refresh the index (incremental
  re-analysis), search symbols (bounded results with path evidence), trace
  a feature (bounded, evidence-backed nodes), and extract memory
  candidates — which land in the memory panel as CANDIDATES for human
  review, never as active memory.
- **Honest states**: a never-analyzed workspace offers a single "Analyze
  workspace" action; load failures render an inline error with retry;
  empty searches and traces say so plainly; truncated traces say so.
- **Trust boundary**: the panel talks only to `src/api/codebase.ts` (safe
  views: paths, counts, statuses, bounded evidence). Source content is
  never rendered here — the file tree remains the content pathway.

## Documents page (Step 23)

`#/documents` (`apps/web/src/pages/DocumentsPage.tsx`) is the document workspace.

- **Honest simulation banner** — states that parsing is real while reasoning
  answers come from a deterministic simulation. It is never hidden behind a menu.
- **Upload + list** — uploads are bounded to the development limit, rejected if
  the file is not identified as a document, and listed with size. Empty state
  explains what to do next.
- **Inspect** — shows the detected format, size and that it came from magic
  bytes, not a filename.
- **Process** — one button, disabled while working, with a visible working state.
  Failure surfaces as a `role="alert"` message, never a silent dead end.
- **Structure** — element, table, section, page/slide/sheet counts; a plain
  truncation notice when a document is large; sections list and extracted text.
  Extracted text renders as text nodes: markup inside a document is displayed,
  never executed.
- **Search** — deterministic text search with an honest "no matches" notice.
- **Ask** — answer with confidence and the verified evidence quotes, labeled
  AI-generated.
- **Summary, entities, sheets, slides** — each section appears only when the
  document supports it; wrong-format requests produce an honest error.
- **Export** — artifact kinds as a labeled select, published through the Step 19
  file system.

Layout reuses the `v-video__*` two-column shell (list panel + content) and
collapses to one column on narrow screens.

## Connected Apps page (Step 24)

`#/connections` is the owner's read-only view of the apps they have connected.

- **Provider cards** show the provider name, an honest mode line (`Live API` or
  `Simulated provider - deterministic demo data, not a real account`), the
  account, the granted scopes and live health once connected, or the permissions
  on offer before connecting.
- **Connect dialog** lists only the provider's declared scopes as checkboxes,
  shows the session's honest authorization note, and disables Authorize when no
  scope is selected. Cancel closes without connecting.
- **Resource browser** lists resources or search results in the left column and
  a detail panel on the right: provenance (provider, account, path, revision,
  retrieval time, source link), structural analysis (format, element and table
  counts, headings) and a bounded content view labelled "Content is untrusted
  data". Narrow viewports collapse to a single column.
- **States**: connect failure renders a `role="alert"` line with the server's
  message; an empty search says no resources matched; a repository selection
  explains that repositories carry no file content; binary resources report
  that there is no text preview rather than showing empty space.

## Brand assets (Step 33)

The supplied artwork ships untouched next to the files the app actually loads:

| File                                        | Role                                          |
| ------------------------------------------- | --------------------------------------------- |
| `veltravia-logo.png` (1024x1024)            | supplied logo, kept at its delivered size     |
| `veltravia-mark.png` (1024x518)             | supplied notification mark, kept as delivered |
| `veltravia-notification-trim.png` (512x512) | notification mark, cropped to its ink         |
| `veltravia-logo-{32,48,96,180,192,512}.png` | favicon and app icons                         |
| `veltravia-notification-{48,96,256}.png`    | status mark sizes for the top bar             |
| `favicon.ico`                               | multi-resolution 16 to 256                    |

Measured on the delivered files: the logo's ink occupies 64% x 52% of its 1024
square and the notification mark's ink 41% x 69% of its 1024x518, so drawing the
wide mark raw put a 14 x 13px shape inside the 20px status chip.

Two derivations, recorded per file in `brand-assets.json`:

- **The app logo is used exactly as delivered** (`exact-rescale`): every icon is
  the 1024 canvas at one uniform scale, so the composition, margins and centring
  are the owner's own. Nothing is cropped, re-centred, recoloured or stretched,
  and the transparent background stays transparent. Because the artwork carries
  its own padding (64% ink), the sidebar draws it in a 38px box so the ink still
  lands at the 24px it was before, rather than shrinking the mark.
- **The notification mark is cropped to its ink** (`ink-crop`): it only ever
  appears as a 24-28px status chip, where its own padding would leave a 10px
  shape. `scripts/trim-brand-assets.py` crops it at an alpha threshold of 128,
  re-centres on a square canvas with 7% padding and writes the chip sizes from
  that trim, 88% ink fill.

`brand-assets.json` records the measurements and the method per file, and
`brand.test.tsx` fails if a logo icon stops being an exact rescale, if the
cropped chip falls below an 80% ink fill, if the originals change size, or if a
cropped copy of the logo reappears.

`BrandMark` serves `srcSet` densities (1x/2x/3x), so a 3x display fetches the
512px file instead of upscaling. The status mark renders at 24px in the top bar
and 28px in the notification panel heading, and the panel shows the 16px heading
unchanged so the mark never outgrows its title.

The mark sits on nothing: `background: transparent`, no chip, no ring, no
shadow, by request, so there is never a grey or dark box around the logo. The
artwork already has transparent corners, and the shape is carried by its violet
to cyan body. About 6.6% of the mark's opaque pixels are the near-white
highlights, which read faintly on the light theme; the earlier dark chip existed
only to make those highlights pop, and the trade was accepted to remove the box.
Measured on the rendered 56px mark on `--v-bg`: computed background
`rgba(0, 0, 0, 0)`, `box-shadow: none`, ink present (violet `#a716fb` through
cyan `#15d4fb`). The mark is static: `brand.css` has no keyframes, animation or
transform, and the test asserts that.

## Assistant chat surface (Step 36 follow-up)

`#/chat` is the application's front door: an empty hash and every unrecognised
hash land here (the dashboard keeps its own route and its sidebar entry). The
page is the reference layout, measured at a 412 dp capture and converted to CSS
pixels:

| Reference                             | Here                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| background `#F9F9F9`                  | `--v-bg` (`#fafafd`)                                                                   |
| composer border `#D1D1D1`, radius 16  | `--v-border-strong`, 16 px                                                             |
| send button `#4250F4`, ~34 px         | `--v-primary` (the brand violet; the reference's blue is not adopted), 32 px, radius 8 |
| placeholder `#8C8C8C`, 16 px          | `--v-text-faint`, `--v-text-lg`                                                        |
| suggestion card radius 12, padding 16 | not drawn: the ways in are plain lines (see below)                                     |
| greeting ~30 px                       | `--v-text-3xl` (30 px), 24 px under 560 px                                             |

Three deliberate departures from the reference:

1. **No phone suggestion.** The reference offers "let your agent call people".
   This build has no calling channel, so it is omitted rather than shown as a
   dead end. The remaining two ways in navigate somewhere real.
2. **No name is invented.** The greeting reads `Hey <name>,` only when the
   owner has given their own name in the agent-name dialog; otherwise
   `Hey there,`.
3. **The mode chip reports a fact.** It reads `Auto` when a provider is
   connected and `Simulated` when none is, and its tooltip quotes the server's
   own reason. It links to model settings.

The composer follows the second reference: one plain field over a control row,
left to right `+`, the mode chip, the dictation control and the send control in
the brand colour, all 32 px squares (the chip 30 px) inside a 86 px tall rounded
grey box with a 16 px inner radius. The placeholder reads `What's on your mind` in a conversation with no turns, and `Type a message…` once the thread has any.
While an answer is in flight an outlined stop control appears **beside** the send
control, which dims and disables, rather than swapping in for it: the row must
not rearrange itself mid-answer, and two adjacent controls must not look alike.
The reference's black action button is rendered in the brand violet, for the same
reason the reference's blue was not adopted.

Under the composer there is nothing. The `Answers can be wrong…` line that used to
sit there is gone by request: the field's bottom edge is the last thing on the
screen, 12 px clear of the window edge at both 390 px and 1440 px, which is the
composer's own footer padding rather than a placeholder for removed copy.

What is wired: `POST /api/reasoning/runs` (profile `workspace`), the previous
turns sent as conversation context, `GET /runs/:id` polled every 900 ms until a
terminal state, and `POST /runs/:id/cancel` from the stop control. A failed run
stays failed with the server's message and an "Ask again" action; a run that
pauses for tool approval says so and links to the reasoning workspace; a
cancelled run says who stopped it. Answers are rendered as plain text.

What is not wired: attachments, `/` shortcuts, streaming tokens, and any
speech-to-text fallback. Dictation uses the browser's own `SpeechRecognition`
and the microphone control is omitted entirely when it is unavailable, so it is
never a decorative button. Every control in the composer does something.

## Naming the agent (Step 36 follow-up)

Every owner names their own assistant, the way the platform this design follows
lets a user rename their agent. The name is what the header shows above the
conversation, and it can be changed at any time.

- **Where it lives.** On `#/chat` the top bar shows the agent's name in place of
  the route title. The name itself is the control: clicking it opens the editor.
  There is no pencil button beside it, by request, so the header stays a plain
  title. `title="Rename your agent"` and the accessible label
  (`Name your agent (currently called <name>)`) keep it discoverable for a mouse
  and a screen reader without adding a second hit target.
- **Two different names.** The agent's name and the owner's account name are not
  the same thing. The dialog edits only `Agent name` (required, up to 40
  characters, counted in characters so emoji and non-Latin names fit); naming
  the agent never touches the account. `Restore the default name` appears only
  once a custom name exists.
- **The greeting uses the account name.** `Hey <account name>,` comes from the
  profile's `ownerName`, which in a deployed build is filled from sign-in. This
  build has no authentication, so nothing sets it and the greeting says
  `Hey there,` - the path works and is tested, but no name is invented.
- **What the server accepts.** `PATCH /api/agent-profile` with `agentName`
  and/or `ownerName` (the account-name slot the greeting reads). Names are trimmed and inner whitespace collapses to one
  space; an empty name, a line break or a control character is refused
  (`AGENT_NAME_INVALID`, 400) rather than silently rewritten, and an over-long
  one is `AGENT_NAME_TOO_LONG`, 422. The refusal never echoes the rejected value.
  `DELETE /api/agent-profile/name` puts the default back and keeps the owner's
  own name.
- **Scope.** The name is display-only. It never reaches a model, never enters a
  run's context and never affects authorisation; renaming grants nothing. Each
  caller names their own agent: the browser sends a stable per-browser owner
  reference (`localStorage['veltravia.owner-ref']`), which is a documented
  stand-in for authentication. Two browsers on one server therefore hold two
  names, and one person across two browsers holds two until real auth exists.
- **Honest storage.** Names live in the API process's memory (bounded, oldest
  owner evicted). A restart restores the default, and the API says so in its
  own `persistence.durable: false` field instead of implying otherwise.

The conversation title while chatting is the agent's name too, so the assistant
being addressed is never ambiguous. `ChatPage` reads both names from the shared
`AgentProfileProvider`, which is why the header, the greeting and the thread
title can never disagree.

## Two layouts, one engine (Step 36 follow-up)

The website and the packaged Android application are deliberately different
arrangements over the same chat engine. The choice is made by
`isPackagedApp()` (Capacitor, or the `capacitor:` protocol) in `ChatPage`, not by
window width, so a narrow browser window stays the website and the phone app
stays the app. Both read their state from one `useChatSession` hook, so the
provider wording, the send rules and the placeholder rules cannot drift; both
use the same `ChatComposer`.

**Website** (`v-chat--web`): the brand mark, a centred greeting, then one plain
line per way in. The composer sits in a 720 px column.

**Packaged app** (`v-chat--app`): no hero mark and no greeting competing for the
screen; the two ways in are the same plain lines, shortened (`Build something
new`), above the type box, with the deliberate whitespace above them, and the
composer floats clear of the gesture bar on a 16 px gutter.

The ways in carry no box. Each is one small line: a 16 px thin-stroke icon, the
sentence in the muted colour, the destination in the brand colour, and a close
control at the far right, all at 13 px (`--v-text-sm`), with 12 px between lines
and a 32 px row. The words are deliberately the smallest type in the composer's
area so the greeting stays the loudest thing on an empty screen.

One shared `SuggestionList` draws the rows for both layouts, so the website and
the packaged app cannot drift apart. Left and right edges are the composer's own:
measured at 1440 px the list starts at 480 px and the close control ends at
1200 px, exactly the type box's edges; at 390 px both are 12 px and 378 px. The
box itself reports `border-top-width: 0px`, `background: transparent`,
`box-shadow: none`; the icons are `stroke-width: 1.7` inheriting `currentColor`.
Contrast on `--v-bg`: sentence 6.4:1, destination 6.0:1, close control 6.4:1 (an
icon-only control needs 3:1, so the faint tone was not used). Dismissing hides
the line for the session and survives a reload; clicking a destination lands on
`#/documents` or `#/builder`.

Where this build departs from the phone reference, and why:

1. **One circle, not two.** The reference's top row has a menu circle on the left
   and a new-conversation circle on the right. The menu already lives in the app
   shell's top bar on this surface, so the chat screen supplies only the
   new-conversation circle. Two menu controls would be worse than one.
2. **The far-right button sends.** The reference's accented far-right control is
   voice mode; this build has no voice mode, so that slot is the send control in
   the brand colour. It is never a decorative waveform.
3. **The type box is identical on both**, as asked. Its placeholder is
   `What's on your mind` on a fresh conversation and `Type a message…` in a
   thread, which is a deliberate departure from the reference's branded wording.
4. **Cards can be dismissed on the website only.** The app's pill rows are two
   lines of plain text, so a dismiss control would crowd them.

The new-conversation circle is outside the chat page's tree, so it announces
itself with a `veltravia:new-chat` window event that `useChatSession` listens
for. One engine still owns the reset.

### Answers carry no brand mark

Every assistant turn used to open with a 24px logo chip. It is gone. The reply
now starts at the thread's left edge on both layouts, which keeps the version
and the conversation legible with one logo on the page rather than one per turn.
A test fails if a `.v-brand-mark` or `img` reappears inside an assistant turn.

### The greeting is quiet, not a headline

The reference landing puts the greeting at roughly 1.75x the suggestion rows. An
h1 at 30px bold against 13px rows was 2.3x, which made the empty screen shout.
It is now 22px at weight 600 on both layouts: 22 / 13 = 1.69, the closest whole
pixel to the reference, where the 20px and 24px scale tokens land at 1.54 and
1.85. Measured live at 390 and 1440: 22px, weight 600, two lines, ratio 1.69, no
horizontal overflow.

### The owner's turns carry their picture

Every user turn ends with a 28px circle at the right, beside the bubble and
aligned with its first line (2px down), with 8px between the bubble and the
circle and the circle's outer edge on the composer's gutter. It is the owner's
turn, so it is theirs to be marked with; the assistant turn still carries
nothing.

The circle is decorative (`aria-hidden`, no `alt`) because announcing "you" on
every message the owner just sent adds noise. It draws, in order of preference:

1. the account photograph (`src`), clipped to the circle with `object-fit: cover`;
2. the **first letter only** of the name given in the agent dialog,
   upper-cased by code point so a name starting with an emoji still works
   ("Ijezie Nwosu" is `I`, not `IN`: two letters read like two people);
3. a thin person glyph when no name has been given.

**This build has no accounts, so there is no photograph to show yet.** The
initials are the honest fallback, not a placeholder pretending to be a photo;
`UserAvatar` already accepts `src`, so an account picture only needs that value
wired in. Measured at 390, 1440 and 390-dark: 28 x 28, `border-radius: 50%`,
letter `I` on `--v-brand-100` at 6.4:1, glyph 5.9:1 on `--v-surface-muted`, no
horizontal overflow, and no circle inside `.v-chat__turn--assistant`.

### The header carries no premium crown yet

The reference puts a crown in the top-right corner as the Premium indicator. That
is what the small violet mark in that slot read as, so it is gone: this build has
no subscription behind a crown, and a premium-looking badge with nothing true
behind it is exactly the kind of decoration this project does not ship.

The bar now shows the menu, the agent name and the account menu, and nothing
else. The notification control that also lived in that slot moved into the
account menu (same honest empty state, now in a dialog), so nothing was lost
while the slot is empty. When premium is real, the crown goes back there.

## The live status line

Above a working answer the chat shows one line: a spinner and the thing the run
says it is doing, with the steps behind it one click away. It stays after the
answer arrives, minus the spinner, so the work is still readable.

Everything on that line comes from the server's own run view, derived by
`describeActivity()` in `pages/chat/activity.ts`:

1. the last executed step's `intent`, which is the only thing actually happening,
2. otherwise `Working on it`, because a run that has published no steps has told
   the page nothing more specific.

A plan is deliberately not used. The line once previewed the plan's first intent
as `Next: …`, which named work that had not started and then repeated itself when
that step really ran: two switches, one of them a guess. Holding `Working on it`
until a step exists gives one switch, and the line only ever describes work that
is happening. Two tests hold this: a run with a plan and no steps keeps the
neutral label, and the label may never contain `next`. Live at 390px, the
sequence is `Working on it` → `Read the readme header`.

The expansion lists the steps with their status (`Done`, `Failed`, `Refused`,
`Waiting for approval`) and duration. At most twelve are kept. Durations round in
integers first, so 1450 ms reads `1.5 s` rather than `1.4 s`.

### Opening a step

A step row is the whole target: 32px tall, tap anywhere. Opening one reveals two
labelled blocks, `Command` and `Output`, both in the mono face at 12px/1.5 on a
bordered surface. This mirrors the reference (a Base44 run, recorded on a phone):
the rows there wear a `</>` and the opened step shows the command above its
output, with the label in small caps above each block.

Neither block is written by the page. Both come from the server's step view
(`reasoning/core/src/step-view.ts`), which turns the engine's tool record into:

| Block     | Source                                         | Ceiling    |
| --------- | ---------------------------------------------- | ---------- |
| `Command` | the tool id, then its arguments as pretty JSON | 1200 chars |
| `Output`  | what the tool returned, or the failure reason  | 4000 chars |

Both are passed through `scrubReasoningText()` first, so a tool that echoes a
credential cannot put one on screen. When either is cut, the panel says
`Longer text was trimmed to fit.` rather than ending mid-sentence silently. A
step with nothing to show says `This step ran no command.` or `This step
returned nothing.`, which is different from a box that merely looks empty.

The raw records never reach the browser: the route narrows every run through
`toRunView()`, which also renames the engine's statuses (`failure` → `failed`,
`denied` → `rejected`) and computes the duration from the two timestamps. Before
this, the page read `step.id` and `step.status` from a payload that carried
`stepId` and `failure`, so a step's status and key were undefined in the DOM.

### The marks on a step

The left mark states what happened, and it is a real knockout: a solid block with
the glyph punched out through an SVG mask, so the page behind shows through the
mark instead of a second colour being painted over the block. Measured on the
rendered page: the failed chip fills `#c2404a` and the pixels inside the cross are
the page background.

| Case                           | Mark                                              |
| ------------------------------ | ------------------------------------------------- |
| command succeeded              | `</>`, the mark it ran under                      |
| step succeeded, nothing to run | tick chip, ink block, tick knocked out            |
| command failed                 | the failed chip replaces `</>`                    |
| refused                        | the same chip, muted, not red: the tool never ran |
| waiting for approval           | pause glyph                                       |

Red is reserved for work that ran and came back broken. A refusal is not a
failure, and colouring it red would say the tool attempted something.

Only the spinner moves, and `prefers-reduced-motion` drops the chevron
transition. No brand mark sits on a turn: answers start at the thread's left
edge, so the page carries one logo (the bar's) instead of one per reply. The
mark that remains, in the bar, stays static per the standing rule.

**Known gap, stated plainly:** the engine publishes tool steps only when a
provider is connected and the run actually calls tools. With no provider
configured (`VELTRAVIA_CREDENTIAL_KEY` unset) every run is the offline
simulation, which answers without tools, so the line correctly reads
`Working on it` and offers nothing to expand. The step-by-step line is verified
in tests against real run payloads; seeing it fill in inside a browser needs a
connected provider.

### The phone navigation drawer

Below 900px the menu is `MobileMenu`, not the desktop sidebar slid in. It was
laid out from a screen recording of a reference drawer (1080px capture, 2.62 px
per dp) and checked in a browser against the same numbers:

| Element            | Reference                                          | Here                                 |
| ------------------ | -------------------------------------------------- | ------------------------------------ |
| panel width        | 863px = 80% of the screen                          | 80% (330dp at 412dp wide)            |
| scrim              | rgb(125) over white, ~51% black                    | rgba(0,0,0,.51)                      |
| row pitch          | ~137px                                             | 52dp                                 |
| icon / label / gap | 24dp / 17dp / 20dp                                 | 24dp / 17px / 20dp                   |
| group label        | 13dp, muted, 28dp above                            | 13px, 600, 28px above                |
| open               | ~267ms, decelerating, settles a hair past its mark | 270ms `cubic-bezier(.18,.9,.3,1.02)` |
| close              | ~200ms                                             | 200ms ease-in                        |

Two groups, both drawn from the routes the app really has: the everyday places
first (Chat, Projects, App Builder, Files & artifacts, Dashboard), then every
other route under one **Tools** label. Nothing is invented; a feature the app
does not have does not get a row. The reference shows a list of pinned
conversations, and there is no conversation history here, so that group is not
drawn.

A pill at the bottom-left starts a new chat and a profile circle at the
bottom-right opens Settings (the circle shows the first letter of the owner's
name, as in the thread). The list fades out beneath them instead of being cut
off. While closed the panel is `inert` and `aria-hidden`, so it cannot be tabbed
into or read out. Reduced-motion users get no slide. The desktop sidebar and its
backdrop are not drawn on a phone.

## Controls under an answer

A finished answer carries one row of muted controls directly beneath it: copy,
one opinion, read aloud, share. The layout is the reference's, the honesty rules
are ours:

- **Copy** writes the answer exactly as shown. It confirms with one quiet word in
  the row (`Copied`) rather than a toast, so the message being copied does not get
  covered by the confirmation.
- **Thumbs** record one opinion per answer and are stored in this browser only.
  The tooltip says so ("Kept in this browser only"); the buttons do not imply that
  the owner is training a model, because nothing is sent anywhere.
- **Read aloud** uses the browser's own speech synthesis and stops on a second
  press. Where the browser has no synthesis the control is not drawn.
- **Share** appears only where the platform exposes a share sheet. Nothing else
  pretends to share.

The row is absent under a turn that is still working, a turn that failed, and a
turn that stopped at its budget: none of them has an answer to act on.

Two controls from the reference are deliberately NOT drawn:

- **Edit** (the pencil) edits a conversation's earlier message in the reference.
  There is no message editing here, so a pencil would only rename the agent under
  a label that means something else.
- **More** (the vertical dots under a message) opens per-message actions that do
  not exist yet. The agent-wide menu already lives in the top bar.

The composer is unchanged by this work: the row is the only addition.

## The plus menu

The composer's plus opens one card above itself, pinned to its left edge, because
the trigger sits at the bottom-left of the screen: opening downwards there falls
off the bottom, and aligning to the trigger's right edge pushes the card off the
left. The card is anchored to the composer, not to the 40px row inside it, so it
clears the input box instead of covering it. Rows are 45px tall with a leading
icon, the panel is 12px-radius with the deep shadow, and it scrolls instead of
overflowing on a short window. Measured at 390x844 and 360x640: inside the
viewport on both, and Escape closes it and returns focus to the plus.

The top of the card is the reference's three rows:

| Row                      | State                                                      |
| ------------------------ | ---------------------------------------------------------- |
| Attach files             | Opens the picker: pictures, PDF, text, markdown, CSV, DOCX |
| Add note                 | Opens a second level listing notes, with a count badge     |
| Upload from Google Drive | Drawn disabled, hint "Not connected"                       |

**Attach files** accepts documents as well as pictures. A picture is previewed as
a thumbnail; anything else becomes a named chip, because a browser cannot draw a
PDF. Attachments still cannot be sent: the run API takes text, so a send with a
file attached is refused with a plain explanation rather than leaving the file
looking sent.

**Add note** is real, and small. The second level lists the notes already written
plus `Write a note…`, and a row opens a dialog to write one. Notes are kept in
this browser only, the row carries a badge with how many there are, and tapping a
note in the list removes it. When a message is sent the notes travel with it,
verbatim, after the person's own words:

```
Build me a page

Notes from the owner:
- keep it short
```

**Upload from Google Drive** has no Drive connection behind it, so it is drawn
disabled with the reason. It is the one row in the card that does not act, and it
says so rather than failing quietly.

Below the reference's three rows sit the actions this product actually has: new
conversation, projects, app builder, model settings.

## The website navigation drawer

The browser gets a drawer of its own (`shell/MobileDrawer.tsx`); the packaged
app keeps the older menu (`shell/MobileMenu.tsx`), chosen by `isPackagedApp()`
rather than by width, because the two are built differently.

**One panel, two frames.** Asking the browser for the desktop site used to show a
second navigation (the 240px rail in `shell/Sidebar.tsx`) with its own rows, its
own collapse control and a "Platform preview" caption, so the same person saw two
different apps depending on the toggle. The website now has one navigation
surface: below 1024px it is a drawer over the page, at or above 1024px the same
`MobileDrawer` stands docked as the page's 280px column (`--docked`, driven by
`shell/use-wide-layout.ts`). Docked it loses the scrim, the close control and the
hamburger, because there is nothing to close; the head keeps its rule, the rows
stay 47dp, and the footer keeps the workspace. The More card is placed from its
row rather than the window edge, and the workspace sheet keeps the 351dp width it
was measured at instead of stretching across the window. Because the panel is now
the only navigation, it carries every destination: Chat, Projects, Dashboard, App
Builder, Superagent operations, Model routing and Settings as rows, the ten
remaining AI-workspace pages behind a folding group (open whenever the current
page lives inside it), and Files, Memory and Data behind More. `Sidebar.tsx` is
still what the packaged app draws.

The drawer is three zones, not one scrolling column: a pinned head (the brand
lockup — the mark, a 6dp gap, then the Veltravia name — with a close control and
no back arrow), a pinned top (the agent card and "New conversation"), a
scrolling middle (the destinations, then the conversation list), and a pinned
footer (the workspace). That is what the reference capture does: the head and
footer hold still while the middle scrolls under them.

The head is closed by a hairline 53dp down the panel (`--v-drawer-line`), and
the agent is a card rather than a bare row, the way the reference draws it:
315 × 42dp with 6dp corners and a hairline border on the panel's own colour
(`--v-drawer-edge`), a 26dp round avatar in the app's accent blue (#3B51E5, the
reference's #3950E5) carrying a white gear, and the agent's name 62dp in from
the card's left edge. "New conversation" follows 15dp below it.

Sizes are measured from the captures rather than chosen: the panel is 83% of
the viewport (341dp of 411dp), its surface is the reference's warm off-white
(`--v-drawer-surface`, `#F8F6F4`) so the white popups read as raised above it,
rows are 47dp with 16dp icons 22dp in and labels 46dp in, and a row's own menu
is a white card 203 × 120dp with 32dp rows and 8dp corners.

There is no **Chat** row: the app already opens on the conversation, so listing
it repeated the screen you were on. The rest live behind **More**, which opens a
separate small card rather than expanding inline — 193 × 116dp, 6dp in from the
panel edge, three 32dp rows (Files, Memory, Data) with 16dp icons 20dp in and
16px labels 45dp in. Files has a screen; Memory and Data are listed with a
"Soon" tag because nothing is behind them yet, and a tag is honest where a row
that silently does nothing is not.

The footer is the workspace, measured off the same reference: a hairline closes
the scrolling middle, then 80dp holding a 43dp tile 13dp in with 5dp corners and
the workspace's own two letters in 13px near-black on the pale green it uses
(`#D9ECDD`), the workspace name at 17px/600 and who is signed in at 15px under
it. It sits on the panel's milk rather than on a white bar. The reference also
puts a workspace-switcher chevron and a bell to the right of it; neither is drawn
here, because Veltravia has one workspace and no notifications, and a control
that opens nothing is worse than a missing one. The app made the same call in the
top bar, where the crown slot stays empty until a subscription exists.

The conversation list collapses: the "Conversations" heading is the toggle, with
the arrow the reference puts right after the word — pointing down while the list
is open and turning to point right once every row is put away. There is no
upgrade card while the product is free.

## Saved conversations (browser only)

`pages/chat/conversations.ts` is the whole store: finished turns are written to
localStorage under the words that started them, newest first, and one
conversation is at most `MAX_TURNS` long. The drawer lists them, a row reopens
the thread through the `veltravia:open-conversation` event (the chat page is the
only thing that owns a thread), and a row's three-dot card does Rename
(inline), Archive (hidden from the list, visible through the filter, restorable)
and Delete (confirmed first). The list shows nine rows and offers "See all..."
only when there are more than nine. Nothing here is on the server: another
device, another browser profile, or cleared site data starts empty.

The chat landing follows the reference too: the ways in are two stacked lines
against the type box (icon, sentence, coloured action, close) rather than chips
in the middle of the screen, the welcome is a headline again (its widest line
337.6dp against the reference's 338dp, mark 72dp), and `index.html` sets
`interactive-widget=resizes-content` so the keyboard shrinks the layout instead
of covering it: the tips and the box rise together and the welcome scrolls out
behind them.

## The workspace sheet

Tapping the drawer's profile line opens a bottom sheet, measured from a screen
recording of the reference (1080 x 2400, 2.628 px per dp). The sheet rises in
about 180ms; a 4dp handle sits 6dp from its top, the workspace line starts 40dp
down, a hairline closes it at 114dp and the credit card begins at 116dp.

The credit card is the part to read carefully. It shows only what the server
knows, from `/api/message-credits`:

- a title and the real renewal date (the month rolls over on the 1st, UTC, which
  is how charges are bucketed),
- the month's credits against the monthly limit, with the reference's 6dp bar
  (orange, red once the limit is reached). With no limit set it prints what was
  spent and draws no bar, rather than inventing a denominator,
- a held-credits row only while credits are actually reserved.

### The rows under the card

Measured from the same reference: sections divided by a `#E7E4E0` hairline, rows
52dp tall, each icon 16dp at 20dp in, its label at 48dp, and a chevron 20dp from
the right edge.

Workspace holds Settings. Under the divider comes the reference's identity line
and its account rows:

- **View profile** opens a dialog with your name and your assistant's name. Both
  are real profile fields, saved through the same API the rename dialog uses, so
  the row writes what it shows and the workspace stops reading "Not signed in".
- **Account preferences** opens Settings, the only preferences surface the app has.
- **Appearance** is a real three-way preference (Light, Dark, System) wired to the
  theme provider, which writes `data-theme` on the root and follows the OS when
  set to System. All sheet colours are tokens, so both themes clear 4.5:1
  contrast (17.5 and 6.7 in light, 14.5 and 6.9 in dark).
- **Language** is a plain row reading English. The app ships one language, so it
  is stated rather than offered as a picker with nothing in it.
- **Help & support** opens a short dialog whose four answers come from behaviour
  that is in the build: monthly reset on the 1st, how Automatic picks a model,
  what happens to a failed message, and where chats and files live.

### The four rows Veltravia cannot honour yet

"Earn free credits" and "Add members" sit above Settings in the workspace
section; "Become an affiliate" and "Log out" sit in the account section, in the
reference's order. None of the four has anything behind it, so each carries a
"Soon" chip and an accessible name of "<label>, not available yet", and tapping
one opens a sentence saying exactly what is missing:

- Earn free credits: no rewards or referral programme.
- Add members: a workspace belongs to one person; teams need shared projects,
  permissions and billing.
- Become an affiliate: no affiliate programme.
- Log out: no accounts or sessions, so there is nothing to sign out of.

That dialog is a real modal, so while it is open the sheet drops `aria-modal` and
becomes `aria-hidden`: a screen reader is never offered two modals. Tapping a
placeholder navigates nowhere and signs nothing out.

Still not drawn, because neither is measured: the daily-limit and
integration-credit meters, and "Upgrade your plan" while there is no paid plan.

While credits load, the card shows the reference's skeleton: four grey blocks
(103x21, then 351 wide at 17, 9 and 30dp tall) that share one animation. The
recording shows no travelling highlight; every block breathes together between
`#F3F1EF` and `#E9E5DF` on a 2s cycle with a held top, so that is what is built.
Reduced-motion users get a still block.

## The More popup

Measured from a capture of the reference with its More row open. The card is
193dp wide and 116dp tall: three 32dp rows with 10dp of padding above and below,
a 10dp radius, a soft shadow (about 8% darkening under the edge, fading inside
10dp) and no border.

Inside a row the icon sits 18dp from the card's edge at 14dp, the label 45dp in at
15px, and the row's whole height is the target. That puts the three labels on the
reference's 32.1dp pitch.

The placement is the part worth knowing: the card's top is flush with the More
row's top and its right edge sits 11dp from the screen edge, so it overhangs the
380dp panel and floats over the scrim. It cannot therefore be a child of the
scrolling list, which would clip it, so its corner is measured from the row when
it opens and the card is fixed-positioned at those coordinates. Scrolling the list
puts it away rather than letting the card drift away from its row.

The scrim behind the drawer measures 0.25 black in the reference (its page reads
#BEBDBB once open), not the 0.45 built earlier.

## The workspace sheet's height

Measured from a capture of the reference with its sheet open: the sheet covers the
page down to a 72dp dimmed strip and stands 681dp tall on a 753dp page. It is
sized by its content, and its content is mostly the credit card, so the earlier
`calc(100% - 232px)` cap was wrong twice over: it reserved a third of the screen
for nothing and it clipped the sheet's own rows. The cap is now
`calc(100% - 72px)`.

Because the sheet's height is driven by the credit card, an unreadable card must
not collapse into a sentence. When `/api/message-credits` fails the card keeps its
head, its "Message credits" row and its track, with the figures printed as "—"
(unknown, not zero: no progress bar claims a value) and the reason underneath.
With that, the sheet stands at the reference's 681dp even on a deployment where
credits cannot be read at all.
