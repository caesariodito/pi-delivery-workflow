# Operator guide

## Prerequisites

Verify Herdr `0.9.5`, protocol `22`, running server, `HERDR_ENV=1`, Pi, Git, clean checkout, ignored `.scratch/`, approved models, and external real worktree root.

```bash
herdr --version
herdr status --json
```

## Start playbook

1. Create reviewed specification, plan, context, and strict tickets.
2. Run `delivery_preview`; inspect graph, initial slots, gates, ownership/read scope, argv, models/tools, limits, warnings, and critical path.
3. Obtain explicit implementation approval.
4. Call `delivery_start` with exact clean `baseSha`. Keep Pi process alive.

```text
/delivery_status {"runId":"run-1"}
/delivery_steer {"runId":"run-1","ticketId":"T1","message":"Use approved API shape."}
```

## Interruption playbook

1. Stop new orchestration actions. Do not reload Pi while run is active or awaiting integration/cleanup.
2. Inspect Herdr agent, pane, workspace, and worktree.
3. Inspect `.scratch/delivery/<run>/` status, prompt, nonce result, logs, patch metadata, and handoff.
4. Treat missing, contradictory, or unknown state as blocked. Preserve resources; do not replay or replace agent.
5. If interrupt is explicitly intended, call `delivery_stop`; then verify actual settlement in Herdr. `Ctrl+C` request is not proof of exit.
6. Start another supervised run only after parent resolves ownership and prior action.

## Read-only reconcile playbook

```text
/delivery_reconcile {"runId":"run-1"}
```

Use after process loss or state doubt. Inspect `contradictions`, `safeActions`, and per-ticket recommendation. Reconcile compares persisted state, Herdr, evidence, and Git without mutation and never infers success. `inspect_and_retain` or contradictory output blocks manual progression; resolve evidence outside runtime before any new launch.

## Timeout and fix playbook

- `timeoutSeconds` is ticket deadline. Runtime waits through repeated Herdr calls of at most 300 seconds and checks live state between calls.
- Deadline expiry marks timed-out/blocked evidence and retains workspace. Do not kill, replay, or replace automatically.
- `validationTimeoutSeconds` bounds each validation. Expiry is validation failure.
- `maxFixRounds: 1` permits one repair only for eligible validation failure. It reuses same agent/pane/worktree but creates fresh nonce, result, prompt, and log evidence. Scope and ownership remain unchanged.
- After exhausted round or any unknown/block/ticket timeout, inspect and retain. Further work needs new parent decision/run.

## Review disposition playbook

1. Parent runs/provides validation; reviewer receives `read` only plus scoped result writer.
2. Inspect verdict (`approve`, `changes_requested`, `blocked`), findings, evidence, affected paths, and residual risks.
3. Verify before/after review and parent Git snapshots. Any mutation or unverifiable state blocks.
4. Decide every finding; runtime never auto-accepts or auto-fixes.
5. Record decision:

```text
/delivery_dispose {"runId":"run-1","ticketId":"R1","disposition":"approve"}
```

Use `changes_requested` or `blocked` when applicable. Only approved disposition lets dependencies proceed and review workspace become cleanup-eligible.

## Metrics playbook

Read `delivery_status.details.metrics`:

- `wallTimeMs`: earliest queue to latest known end;
- `workerTimeMs`: sum of recorded worker elapsed time;
- `utilization`: worker time divided by wall time and concurrency;
- `criticalPath`: dependency path weighted by ticket total elapsed time;
- `counts`: validations, fixes, blocks, reviews, cleanups;
- `incomplete` and `missingTiming`: fields that cannot be computed.

Treat `null` plus incomplete flag as unknown. Never substitute zero. Metrics are local inspection data; package exports no telemetry.

## Integration playbook

1. At `awaiting_integration`, inspect result, worktree, branch, changed paths, validation log, handoff, patch, and digest.
2. Manually integrate accepted exact changes into clean parent checkout and commit.
3. Run parent acceptance checks.
4. Call `delivery_continue` with current clean HEAD:

```text
/delivery_continue {"runId":"run-1","integratedSha":"<current-clean-head>"}
```

Runtime rehashes patch and requires exact reverse applicability. Equivalent byte-different work remains unintegrated. Optional integration validation runs with bounded executable/argv before downstream launch; failure blocks and launches nothing.

## Cleanup playbook

1. Confirm final acceptance and no ticket still needs retained workspace.
2. Read status/reconcile if state is uncertain.
3. Invoke explicit run-scoped cleanup:

```text
/delivery_cleanup {"runId":"run-1"}
```

Cleanup removes only exact integrated implementation work or approved disposed review work when inactive and identity-matched. It preserves branches and `.scratch/` evidence. Pre-removal failure can be retried after correction. Removal-success/state-write-failure is ambiguous: inspect Herdr and evidence; never replay automatically.

## Publication playbook

1. Finish review disposition, integration, checks, acceptance, and cleanup inspection.
2. Parent runs `npm run check` and `npm pack --dry-run` in clean checkout.
3. Inspect package contents and version separately.
4. Obtain explicit publication authority naming push/tag/package/release action.
5. Perform only approved action outside Delivery. Delivery never merges, pushes, tags, publishes, deploys, or releases.
