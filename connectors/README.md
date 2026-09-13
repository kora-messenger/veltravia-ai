# connectors/ — external-service integration (future)

- `core/` — the connector interface, lifecycle, and **credential isolation**
- `providers/` — individual connectors (Slack, GitHub, Google, …), one package each

**Step 4 scope — no code yet.** Credentials are held by the core and never exposed to generated project code (see docs/security.md §5).
