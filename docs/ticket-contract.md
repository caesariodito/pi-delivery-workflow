# Ticket contract

`delivery_start` accepts strict ticket objects. Unknown fields fail validation.

## Implementation ticket

```json
{
  "id": "T001",
  "mode": "implementation",
  "goal": "Implement bounded behavior",
  "definitionOfDone": "Focused test passes and owned changes are complete",
  "dependencies": [],
  "ownedPaths": ["src/feature.ts", "test/feature.test.ts"],
  "forbiddenScope": "Dependencies, migrations, and files outside ownership",
  "worker": {
    "name": "worker-t001",
    "kind": "worker",
    "model": "9router/cx/gpt-5.6-sol",
    "thinking": "medium",
    "tools": ["read", "write", "edit", "bash"]
  },
  "validation": { "executable": "node", "args": ["--test", "test/feature.test.ts"], "cwd": "." },
  "requiresIntegratedBase": true,
  "maxFixRounds": 1,
  "timeoutSeconds": 900,
  "validationTimeoutSeconds": 300,
  "specPaths": [".scratch/task/spec.md"]
}
```

`mode` defaults to `implementation`. Defaults: `maxFixRounds: 0`, `timeoutSeconds: 300`, `validationTimeoutSeconds: 300`. Bounds: fix rounds `0..1`, ticket timeout `60..7200`, validation timeout `30..1800` seconds.

## Review ticket

```json
{
  "id": "R001",
  "mode": "review",
  "goal": "Review integrated change",
  "definitionOfDone": "Structured verdict recorded",
  "dependencies": ["T001"],
  "ownedPaths": [],
  "readPaths": ["src/", "test/"],
  "worker": {
    "name": "reviewer-r001",
    "kind": "reviewer",
    "model": "9router/cc/claude-opus-5-5",
    "thinking": "medium",
    "tools": ["read"]
  },
  "validation": { "executable": "npm", "args": ["run", "check"] },
  "maxFixRounds": 0
}
```

Review validation is parent-run. Review requires empty `ownedPaths`, non-empty `readPaths`, exactly `read` tool, and zero fixes.

## Run fields

Run accepts `runId`, objective, exact Git `baseSha`, `worktreeRoot` for start, tickets, optional context paths, concurrency `1..8`, and optional integration validation:

```json
{
  "integrationValidation": {
    "executable": "npm",
    "args": ["run", "check"],
    "cwd": ".",
    "timeoutSeconds": 300
  }
}
```

Integration timeout bound is `30..1800` seconds.

## Rules

- IDs and worker names are safe/unique; graph is acyclic.
- Paths are normalized repository-relative exact files or directory prefixes ending `/`.
- Implementation ownership does not overlap.
- Commands are executable plus argv, never shell text.
- `kind` accepts `pi`, `worker`, or `reviewer`; aliases launch through Herdr kind `pi`.
- `contextPaths` exist at launch. `specPaths` are checked when ticket becomes ready.
- `requiresIntegratedBase: true` waits for exact integration. `false` permits textual handoff after validation.
- Optional context fields are arrays: `observableBehavior`, `acceptanceExamples`, `nonGoals`, `entryPoints`, `invariants`, `expectedValidation`, `unresolvedDecisions`.

## Results

Implementation result remains version 1:

```json
{"version":1,"ticketId":"T001","status":"done","summary":"Implemented feature","changedPaths":["src/feature.ts"],"validation":"passed","handoff":"Exports X","question":null}
```

Review result is version 1 with `verdict` (`approve`, `changes_requested`, `blocked`), summary, findings, residual risks, and question. Each finding has severity (`critical`, `high`, `medium`, `low`), affected path, evidence, and `disposition: "open"`.

Result claims do not prove changes or validation. Runtime checks Git, executes implementation validation, and records immutable patch evidence. Review result remains `reviewed` until parent calls `delivery_dispose` with matching disposition.
