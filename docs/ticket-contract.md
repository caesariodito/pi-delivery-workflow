# Ticket contract

`delivery_start` accepts ticket objects directly.

```json
{
  "id": "T001",
  "goal": "Implement bounded behavior",
  "definitionOfDone": "Focused test passes and owned changes are complete",
  "dependencies": [],
  "ownedPaths": ["src/feature.ts", "test/feature.test.ts"],
  "forbiddenScope": "Dependencies, migrations, and files outside ownership",
  "worker": {
    "name": "worker-t001",
    "kind": "pi",
    "model": "9router/cx/gpt-5.6-sol",
    "thinking": "medium",
    "tools": ["read", "write", "edit", "bash"]
  },
  "validation": {
    "executable": "node",
    "args": ["--test", "test/feature.test.ts"],
    "cwd": "."
  },
  "requiresIntegratedBase": true,
  "specPaths": [".scratch/task/spec.md", ".scratch/task/plan.md"]
}
```

Rules:

- IDs are safe and unique.
- Dependencies exist and graph is acyclic.
- Owned paths are normalized relative exact files or directory prefixes ending `/`.
- Ownership does not overlap across tickets.
- Validation is executable plus argv, never shell text.
- Worker model, thinking, kind, and tools are explicit.
- `requiresIntegratedBase: true` pauses dependent ticket until parent integration.
- `false` allows textual dependency handoff without integration.

Agent result schema:

```json
{
  "version": 1,
  "ticketId": "T001",
  "status": "done",
  "summary": "Implemented feature",
  "changedPaths": ["src/feature.ts"],
  "validation": "passed",
  "handoff": "Exports function X for T002",
  "question": null
}
```

Result claims do not establish changed paths or validation. Runtime checks Git and executes validation.
