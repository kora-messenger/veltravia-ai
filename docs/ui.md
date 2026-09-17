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
- `TopBar.tsx` — page context title, mobile navigation trigger, account
  menu (theme cycling; account/sign-out are explicitly disabled until
  authentication exists).
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
   parameters, or browser-visible API responses. The only localStorage key
   used today is the theme preference.
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
