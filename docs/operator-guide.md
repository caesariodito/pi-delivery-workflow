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

`delivery_steer` targets exact active worker. `delivery_reply` remains registered but is reserved: current runtime does not persist `ticket.question`, so normal blocked-decision replies are rejected. Resolve such decisions outside this control API. Stop sends `C-c` only to recorded worker and waits for that worker to settle; it neither stops nor proves inactivity of reviewer targets. `stop_unconfirmed` requires manual inspection.

## Integrate and continue

Completed batch pauses at `awaiting_integration`. Parent:

1. inspect ticket state, validation log, reviewer result, frozen patch, and handoff;
2. integrate only reviewed `done` candidates, including reviewed deletions;
3. commit integration on clean parent checkout;
4. call `/delivery_continue {"runId":"refresh-token","integratedSha":"<sha>"}`;
5. let runtime verify ancestry, exact content hashes or deletion sentinels, and configured validation;
6. start/observe next ready batch or final acceptance.

Deleted paths pass only when exact path is absent at integrated commit. Git errors, unexpected object types, and content/deletion mismatches fail closed. Do not claim done from child prose.

## Recovery

After restart, detached entry claims runner ownership only when no live/unknown owner exists, then reconciles before consuming controls or scheduling. Recovery queries exact retained Herdr identity and accepts only settled, schema-valid, candidate-bound evidence. Exact reviewed completion resumes without launching replacement worker/reviewer or model fallback. Incomplete, ambiguous, unavailable, or non-settled recovery blocks affected lanes and preserves state, prompts, results, receipts, patches, handoffs, worktrees, and identity evidence. Inspect blocked state and escalate; do not hand-edit state to manufacture progress.

## Manual cleanup

Herdr worktrees remain after done, blocked, or stopped state. `stopped` proves only recorded worker settled. Before cleanup, manually verify recorded worker and every reviewer target and pane are inactive, inspect ownership evidence, and require clean worktree state; preserve and reconcile any dirty changes rather than discarding them. Then remove worktree through Herdr/operator process. Delete `.scratch/delivery/<run-id>/` only when audit/recovery files are no longer needed. Package never performs cleanup automatically.

## Legacy and upgrade

Legacy pi-subagents run state is unsupported. Detection is read-only; status reports `unsupported`, and control/continuation refuse it. Use old install to settle old agents, preserve evidence, remove old dependency, install current package, verify Herdr, reload, and create new run. No conversion or continuation exists.

## Live fixture and publication

Automated checks mock Herdr. Before release, run [manual fixture](../CONTRIBUTING.md#manual-live-fixture) in disposable repository and retain redacted evidence for status, worker/reviewer result protocol, integration, stop, and cleanup. No package publication, tag, push, merge, deployment, or release without separate authority.
