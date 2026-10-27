# Operator guide

## Prerequisites

Verify Herdr `0.9.5`, protocol `22`, running server, `HERDR_ENV=1`, Pi, Git, clean checkout, ignored `.scratch/`, and approved models.

```bash
herdr --version
herdr status --json
```

## Run

1. Use `/delivery <objective>` to prepare plan and bounded tickets.
2. Obtain explicit implementation approval.
3. Call `delivery_start` with ticket array, exact base SHA, outside-repository worktree root, source-document paths, and concurrency.
4. Keep Pi process alive while attached orchestration runs.

Use:

```text
/delivery_status {"runId":"run-1"}
/delivery_steer {"runId":"run-1","ticketId":"T1","message":"Use approved API shape."}
/delivery_stop {"runId":"run-1","ticketId":"T1"}
```

Steer works only while same Pi process owns active run. Stop sends `Ctrl+C`; it does not prove agent exited. Inspect Herdr directly.

## Inspect

For each ticket, inspect:

- Herdr agent and pane;
- retained worktree and branch;
- context packet;
- result JSON;
- validation log;
- concise handoff;
- immutable patch and digest metadata;
- Git changes.

Persisted status is inspection aid. Herdr is live process authority.

## Integrate

When run pauses at `awaiting_integration`:

1. inspect completed handoffs and worktrees;
2. manually integrate accepted changes into clean parent checkout;
3. commit;
4. call `delivery_continue` with current clean HEAD SHA.

Package rehashes each persisted patch and requires exact reverse applicability at clean current parent HEAD. Only then does it mark tickets `integrated` and launch next ready tickets from supplied base. Equivalent but byte-different rewrites remain unintegrated. Package does not apply patches or commits.

## Failure

- `blocked`: answer question outside runtime or start new supervised run.
- `failed`: inspect validation log and worktree.
- unknown/missing result: inspect pane; do not replay automatically.
- parent process died: inspect retained resources; no transparent recovery exists.
- timeout: agent remains operator-controlled unless explicitly stopped.

## Cleanup

After final accepted output is integrated, inspect `delivery_status`, then invoke:

```text
/delivery_cleanup {"runId":"run-1"}
```

Cleanup is explicit and run-scoped. It attempts every eligible `integrated` ticket in stable ID order. Before `herdr worktree remove --force`, package rechecks clean parent HEAD, patch digest, exact integration, recorded workspace/path, and inactive live agent state. `validation_passed`, blocked, failed, stopped, running, unknown, mismatched, legacy, or missing workspaces are retained with reasons.

Repeated calls are idempotent: `cleaned` tickets produce no second removal. Partial removal failure leaves ticket `integrated`, reports exact resource, and continues. If Herdr removal succeeds but state persistence fails, stop and inspect Herdr plus preserved `.scratch/` evidence; never replay automatically. Cleanup preserves branches, prompts, results, handoffs, logs, patches, metadata, and run status.
