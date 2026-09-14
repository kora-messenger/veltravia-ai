# Web UI Foundation (Step 11A)

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
  `#/settings`); unknown hashes fall back to the dashboard.

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
(navigation, active state, collapse, drawer), theme behavior, and
component states (disabled, loading, error, keyboard, ARIA wiring).
