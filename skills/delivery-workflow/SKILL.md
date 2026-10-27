---
name: delivery-workflow
description: Plan and run visible supervised ticket work through Herdr. Use when `/delivery` asks for dependency-aware parallel agents with parent-controlled integration.
---

# Delivery workflow

Parent owns decisions, ticket approval, integration, cleanup, and publication. Herdr owns visible worktrees, panes, and agent processes. Package coordinates only current supervised run.

## 1. Classify

Keep small linear work direct. Use workflow when bounded tickets, dependencies, parallel worktrees, or visible agent supervision add value.

## 2. Prepare

Create ignored `.scratch/<task>/` artifacts:

- `spec.md`
- `plan.md`
- `context.md`
- `tickets.json`
- optional `tickets/<id>.md`

If finalized implementation-review artifacts exist, use their JSON as source and resolve blocking questions before implementation.

Tickets must include one goal, clear done criterion, dependencies, exact non-overlapping ownership, forbidden scope, explicit worker model/thinking/tools, executable/argv validation, and whether integrated dependency code is required.

Use this model policy when assigning Delivery roles:

- default auxiliary and research work: `9router/cx/gpt-5.6-sol`, `medium`;
- scout/recon: `9router/cx/gpt-5.6-luna`, `low`;
- implementation worker: `9router/cx/gpt-5.6-sol`, `medium`;
- reviewer: `9router/cc/claude-opus-5-5`, `medium`;
- oracle/advisor: `9router/cx/gpt-5.6-sol`, `high`.

Keep thinking at or below `high`. Every executable ticket still carries its exact approved model and thinking values; no fallback is allowed.

## 3. Approve

Present objective, tickets, dependencies, ownership, concurrency, models/tools, validation, worktree root, integration boundaries, and stop conditions. Obtain explicit implementation approval.

Approval excludes dependency additions, product/architecture changes, broader ownership, migrations, destructive actions, integration, cleanup, merge, push, publication, deployment, and release.

## 4. Execute

Verify clean checkout, ignored `.scratch/`, `HERDR_ENV=1`, Herdr `0.9.5` protocol `22`, and configured models.

Call `delivery_start` with approved object. Keep Pi process alive. Runtime writes one context packet per ready ticket, creates visible Herdr worktrees/panes, starts approved agents, waits for nonce-bound result, runs validation, records Git-backed handoff, and launches newly ready tickets up to concurrency.

No automatic reviewer/fix loop exists. Parent may separately request review when needed.

## 5. Supervise

- `delivery_status` reads persisted inspection state.
- `delivery_steer` sends bounded guidance only while run is active in current Pi process.
- `delivery_stop` sends `Ctrl+C`; inspect Herdr to confirm state.

Blocked/failed/unknown work retains pane and worktree. Never replay ambiguous prompt or replace unknown agent.

## 6. Integrate

At `awaiting_integration`, inspect worktree, branch, changed paths, validation log, result, and handoff. Parent manually integrates accepted changes and commits clean parent checkout. Call `delivery_continue` with current HEAD SHA. Downstream code tickets then launch from new base. Text-only tickets may set `requiresIntegratedBase: false`.

## 7. Interruption and finish

No daemon or transparent crash recovery exists. If Pi exits, inspect Herdr and `.scratch/delivery/<run>/`; start a new supervised run only after ownership is clear.

Parent reports completed/blocked tickets, validation, worktrees, branches, handoffs, and residual risks. Cleanup and publication remain explicit separate actions.
