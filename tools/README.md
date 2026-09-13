# tools/ — the tool & function system

A **tool** is a controlled, declared operation that Veltravia AI's future agent layer may request — eventually routing through connectors to external services. The tool system sits ABOVE the connector architecture (Step 4) and never bypasses it.

```
tools/
├── core/   # @veltravia/tool-core - IMPLEMENTED (Step 5)
└── mock/   # @veltravia/tool-mock - IMPLEMENTED (Step 5)
```

Details: [docs/tools.md](../docs/tools.md).
