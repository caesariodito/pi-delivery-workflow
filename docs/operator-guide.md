# Operator guide

## Prerequisites

```bash
herdr --version
herdr status --json
```

Require Herdr `0.9.5`, protocol `22`, running compatible server, Git, Pi, and configured `9router/cx/gpt-5.6-sol` worker plus `9router/cc/claude-opus-5-5` reviewer. Reload Pi after package install.

## Start

```text
/delivery <objective>
```

Small linear work stays direct. Workflow path: spec, fresh review, plan, fresh review, bounded tickets, explicit approval, isolated implementation, validation, fresh review, bounded fixes, parent integration, final acceptance.

Use `delivery_review` for spec/plan/implementation artifacts. It requires `runId`, `kind`, `.scratch/` artifact path, `.scratch/` context path, and optional focus. Review launches detached and writes status/result under `.scratch/delivery/<run-id>/`.

After approval, call `delivery_start` with:

- safe `runId`;
- exact approved base SHA;
- serialized ticket array;
- validation `{ executable, args, cwd? }`;
- optional concurrency 1–8.

Each ticket includes dependency/batch, owned and forbidden paths, absolute worktree path, branch, immutable ticket/context text, fix ceiling, worker/reviewer Herdr names, kinds, panes and session evidence, plus artifact mappings. Setup uses argv arrays. Never pass shell command text.

## Supervise

Tool calls use objects; command wrappers accept JSON.

```text
/delivery_status {"runId":"refresh-token"}
/delivery_steer {"runId":"refresh-token","ticketId":"T001","message":"Focus on approved replay test."}
/delivery_stop {"runId":"refresh-token"}
```

`delivery_steer` targets exact active worker. `delivery_reply` remains registered but is reserved: current runtime does not persist `ticket.question`, so normal blocked-decision replies are rejected. Resolve such decisions outside this control API; current detached runtime exposes no operator recovery/resume path after runner death. Stop sends `C-c` only to recorded worker and waits for that worker to settle; it neither stops nor proves inactivity of reviewer targets. `stop_unconfirmed` requires manual inspection.

## Integrate and continue

Completed batch pauses at `awaiting_integration`. Parent:

1. inspect ticket state, validation log, reviewer result, frozen patch, and handoff;
2. if any changed path is deleted, stop: do not integrate or continue; preserve evidence and escalate because deletion support is pending;
3. integrate only reviewed `done` candidates without deletions;
4. commit integration on clean parent checkout;
5. call `/delivery_continue {"runId":"refresh-token","integratedSha":"<sha>"}`;
6. let runtime verify ancestry, path hashes, and configured validation;
7. start/observe next ready batch or final acceptance.

Current verifier expects `git show` content for every changed path, so deletion integration is rejected. Failed verification leaves lane blocked. Do not claim done from child prose.

## Recovery

After Pi interruption, first establish detached runner still exists before using status/control as live operations. If runner is missing or died, state may remain `active` and inbox will remain unconsumed. Treat run as blocked:

1. do not send `delivery_steer`, `delivery_reply`, `delivery_stop`, or `delivery_continue`;
2. do not integrate candidate;
3. preserve state, config, prompts, results, receipts, patches, handoffs, worktrees, and Herdr identity evidence;
4. inspect recorded worker and reviewer targets without changing them;
5. escalate missing-runner condition;
6. do not start fallback or replacement writer.

No automatic crash restart/reconciliation is wired into detached entry. Exact-settled recovery exists only as unit-tested internal runner/scheduler seam and is not exposed to operator. Do not hand-edit state to manufacture progress.

## Manual cleanup

Herdr worktrees remain after done, blocked, or stopped state. `stopped` proves only recorded worker settled. Before cleanup, manually verify recorded worker and every reviewer target and pane are inactive, inspect ownership evidence, and require clean worktree state; preserve and reconcile any dirty changes rather than discarding them. Then remove worktree through Herdr/operator process. Delete `.scratch/delivery/<run-id>/` only when audit/recovery files are no longer needed. Package never performs cleanup automatically.

## Legacy and upgrade

Legacy pi-subagents run state is unsupported. Detection is read-only; status reports `unsupported`, and control/continuation refuse it. Use old install to settle old agents, preserve evidence, remove old dependency, install current package, verify Herdr, reload, and create new run. No conversion or continuation exists.

## Live fixture and publication

Automated checks mock Herdr. Before release, run [manual fixture](../CONTRIBUTING.md#manual-live-fixture) in disposable repository and retain redacted evidence for status, worker/reviewer result protocol, integration, stop, and cleanup. No package publication, tag, push, merge, deployment, or release without separate authority.
