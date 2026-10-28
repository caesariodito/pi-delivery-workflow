---
name: delivery-workflow
description: Plan and run visible supervised ticket work through Herdr. Use when `/delivery` asks for dependency-aware parallel agents with parent-controlled integration.
---

# Delivery workflow

Parent owns decisions, approval, review disposition, integration, cleanup, acceptance, and publication. Herdr owns visible worktrees, panes, and agents. Package coordinates current supervised run only.

## 1. Classify and prepare

Keep small linear work direct. For workflow work, create ignored `.scratch/<task>/` spec, plan, context, and tickets. Resolve blocking decisions first.

Each ticket needs one goal, checkable done criterion, dependencies, exact non-overlapping ownership or review read scope, forbidden scope, explicit model/thinking/tools, executable/argv validation, bounded ticket/validation timeout, fix limit, and integrated-base choice. Add observable behavior, examples, non-goals, entry points, invariants, expected validation, and unresolved decisions when known.

Run `delivery_preview`. Confirm deterministic graph, initial slots, integration/review gates, paths, argv, models/tools, fix/time limits, warnings, stop conditions, and critical path.

## 2. Approve

Present objective, tickets, dependencies, authority, concurrency, models/tools, validation, worktree root, integration/review boundaries, cleanup plan, and stop conditions. Obtain explicit implementation approval.

Approval excludes dependencies, product/architecture changes, broader ownership, migrations, destructive actions, integration, cleanup, merge, push, publication, deployment, and release.

## 3. Execute

Verify clean exact base, ignored `.scratch/`, `HERDR_ENV=1`, Herdr `0.9.5` protocol `22`, external worktree root, and configured exact models. No fallback.

Call `delivery_start`. Keep Pi alive. Runtime fills free slots, persists each settlement, stops new launch after first non-success, and drains already-active work. Herdr waits stay at most 300 seconds; ticket deadline may span repeated waits. Validation uses separate timeout. Approved `maxFixRounds: 1` means one same-agent/same-worktree repair with fresh evidence after eligible validation failure only.

## 4. Supervise and reconcile

- `delivery_status`: inspection state, lifecycle, verdicts, resources, metrics, next action.
- `delivery_steer`: bounded guidance to active same-process agent.
- `delivery_stop`: send `Ctrl+C`; verify settlement in Herdr.
- `delivery_reconcile`: read-only persisted/Herdr/evidence/Git comparison.

Unknown or contradictory state blocks. Retain resources; never replay, replace, infer success, or reload during active/integration/cleanup state. Metrics with `null` and incomplete flags remain unknown, not zero.

Review tickets use empty ownership, explicit read paths, `read` only, zero fixes, and parent-run validation. Git snapshots detect mutation, not sandbox it. Parent inspects verdict/findings and calls `delivery_dispose` with `approve`, `changes_requested`, or `blocked`. Runtime never auto-accepts or auto-fixes review.

## 5. Integrate

At `awaiting_integration`, inspect worktree, branch, Git paths, validation log, result, handoff, patch, and digest. Parent manually integrates accepted exact changes, runs checks, and commits clean checkout. Call `delivery_continue` with current HEAD. Runtime proves exact integration and runs optional bounded integration validation before downstream launch.

## 6. Finish

Report tickets, validation, review disposition, retained resources, metrics/incomplete data, handoffs, and residual risks. After final acceptance, parent explicitly calls `delivery_cleanup`; ambiguous removal state requires manual inspection, not replay. Cleanup preserves branches/evidence.

Publication playbook stays separate: parent runs required checks and pack dry-run, inspects package/version, obtains explicit authority, then performs only approved merge/push/tag/publish/deploy/release action outside Delivery.
