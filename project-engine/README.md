# project-engine/ — isolated execution engine (future)

- `filesystem/` — virtual filesystem layer for generated projects (the only code that touches project files)
- `workspace/` — workspace/session management: create, snapshot, restore, clean up
- `execution/` — sandboxed command execution: containers, resource limits, restricted network

**Step 3 scope — no code yet.** The AI never receives unrestricted host access; this engine is the enforcement point (see docs/security.md §3).
