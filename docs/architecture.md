# Architecture

## Design goal

Provide repeatable path from ambiguous objective to reviewed implementation while parent Pi session remains authoritative. Herdr supplies worktrees, panes, agent lifecycle, prompts, waits, reads, stop keys, and notifications. Package supplies contracts, durable state, validation, review binding, scheduling, and Pi controls.

## Components

### Pi extension

`extensions/delivery-workflow.ts` registers `/delivery` plus model-callable tools and same-name JSON command wrappers:

- `delivery_review`
- `delivery_start`
- `delivery_status`
- `delivery_steer`
- `delivery_reply` (reserved; current state lacks persisted `ticket.question`, so normal blocked-decision replies are rejected)
- `delivery_continue`
- `delivery_stop`

No workflow-resource registry exists. Tools call `extensions/delivery-workflow-core.mjs` directly.

### Detached core

Core validates `.scratch/` review inputs or approved ticket graph, writes durable configuration/state, and spawns Node entry with discrete argv and `shell: false`. `delivery_review` starts standalone review. `delivery_start` starts scheduler. Control tools append exclusive inbox requests.

### Herdr adapter

`extensions/lib/herdr.mjs` uses `execFile` with argv arrays and bounded output/time. Supported baseline is Herdr `0.9.5`, protocol `22`. Adapter maps:

| Need | Herdr command |
| --- | --- |
| Compatibility | `herdr --version`, `herdr status --json` |
| Worktree allocation | `herdr worktree create ... --no-focus` |
| Agent launch | `herdr agent start ... -- <Pi argv>` |
| Prompt/wait | `herdr agent prompt ... --wait --until ...` |
| Recovery identity | `herdr agent get` |
| Stop | `herdr agent send-keys ... C-c`, then `agent wait` |
| Completion notice | `herdr notification show` |

Worker Pi argv pins model. Reviewer Pi argv also loads packed `reviewer-result-tool.ts`, binds result path and nonce, and limits tools to `read,grep,find,ls,delivery_result_write`.

### Runner and scheduler

`extensions/delivery-runner.mjs` exports runtime from `extensions/lib/runner.mjs`. Runner:

1. validates immutable approved contract;
2. asks Herdr for exact approved worktree/path/pane;
3. starts sole writer and sends prompt-file pointer;
4. requires exclusive 0600 worker result file;
5. captures Git evidence and rejects ownership violations;
6. runs validation executable/argv without shell;
7. freezes patch and candidate digest;
8. starts fresh reviewer with scoped result tool;
9. checks reviewer result, nonce path, candidate hash, and post-review drift;
10. resumes retained writer for bounded accepted findings;
11. writes handoff manifest only after clean review.

Scheduler launches dependency-ready batches, caps concurrency, serializes durable state, pauses at `awaiting_integration`, verifies parent integration, and applies control inbox requests.

### Result protocol

Worker writes one package-prescribed result file. Reviewer cannot use generic write/edit/bash; `delivery_result_write` exclusively creates configured 0600 file after nonce match. Reviewer result binds frozen candidate SHA-256. Missing, malformed, duplicate, unbound, or drifted result blocks lane.

## Authority

Parent controls requirements, product/architecture decisions, finding disposition, approved tickets, integration, final acceptance, cleanup, and publication. Worker controls implementation inside approved ownership. Reviewer supplies evidence only.

## Durability and recovery

Run state lives under `.scratch/delivery/<run-id>/`. Prompt files, result pointers, validation logs, frozen patches, receipts, and manifests support inspection. Runner never infers completion from prose. Unknown process/agent identity, partial stop, missing result, or stale ownership blocks rather than spawning replacement.

Detached entry does not wire automatic crash restart or reconciliation. A dead runner may leave phase `active` and durable inbox requests unconsumed. Operators must treat missing runner as blocked, send no controls, perform no integration, preserve all evidence, and escalate without fallback/replacement. Runner/scheduler exact-settled reconciliation functions are unit-tested internal seams only; detached runtime does not invoke them.

Parent integrates completed batch and calls `delivery_continue` with exact SHA. Scheduler verifies clean checkout, base ancestry, changed-file hashes, and validation before next batch. Verification currently expects content for every changed path, so deletions fail. Any deletion handoff must remain blocked and unintegrated pending deletion support.

## Limits

- No automatic Herdr install/start/upgrade.
- No live compatibility claim beyond `0.9.5` protocol `22` until manual fixture evidence exists.
- No automatic worktree cleanup.
- No automatic patch integration, merge, push, deploy, release, or publication.
- No migration from legacy runtime state.
- No model/provider/execution fallback.
