---
name: delivery-workflow
description: Design and deliver non-trivial implementation through reviewed specs, plans, bounded tickets, isolated workers, and fresh review gates. Use when `/delivery` asks for this workflow or when user explicitly requests reviewed ticket-based unattended implementation.
---

# Delivery workflow

Parent owns requirements, decisions, finding disposition, integration, final acceptance, cleanup, and publication. Package runner owns durable scheduling/contracts; Herdr owns worktrees, panes, agent lifecycle, prompts, waits, stop, and notifications.

## 1. Classify

Before implementation classify work:

- **Direct** — small, linear, well-understood. Work directly.
- **Workflow candidate** — reviewed spec, bounded seams, fresh review, isolation, or unattended execution materially helps.
- **Uncertain** — ask user which mode.

Delegation authorization covers discovery/review needed for proposal, not implementation. Obtain explicit plan-wide approval after reviewed tickets and execution proposal exist.

## 2. Prepare artifacts

Find repository root. Confirm `.scratch/` ignored. Use `.scratch/<task>/` with safe slug. Never copy credentials, raw session history, auth files, MCP tokens, or unrelated private context.

Create durable human artifacts:

- `spec.md`
- `plan.md`
- `context.md`
- `tickets.json`
- `tickets/<id>.md`

Runtime evidence lives separately under `.scratch/delivery/<run-id>/`.

If finalized `implementation-review` artifacts exist for task, use them from same `.scratch/<task>/` directory. Validate source JSON and require rebuilt review pages with no unresolved implementation-blocking questions. Treat JSON as source; HTML and exported answers are review transport only.

## 3. Compose and review specification

Use finalized `implementation-plan.json`, when present, for `spec.md` problem, goals, scope, non-goals, and acceptance criteria. Enrich from `technical-spec.json`, when present, with behavior, contracts, data, architecture, trust boundaries, failure handling, security, technical verification, constraints, and open technical decisions. Preserve stable IDs where useful. Without review artifacts, brainstorm same contract. Ask only missing, conflicting, product, or architecture decisions; do not repeat settled questions.

Call `delivery_review` with object:

```json
{
  "runId": "<safe-review-id>",
  "kind": "spec",
  "artifact": ".scratch/<task>/spec.md",
  "contextBundle": ".scratch/<task>/context.md"
}
```

Review is detached, fresh, read-only, fixed `9router/cc/claude-opus-5-5`, and scoped structured result. Inspect runtime review status file when review process settles; do not use polling loops. Parent classifies each finding valid, stale, invalid, speculative, or blocked, revises accepted findings, and asks user about product/architecture decisions.

## 4. Compose plan, review, and ticket

Use finalized `implementation-plan.json`, when present, for business context, scope, seams, contracts/files, workstreams, ordering, ownership, dependencies, validation, rollout risk, definition of done, and ticket boundaries. Otherwise derive same plan from reviewed spec. Keep technical detail in `spec.md`. Resolve conflicts by owner: `technical-spec.json` owns technical contracts; `implementation-plan.json` owns delivery decisions. Review plan with `delivery_review` kind `plan`, then revise accepted findings.

Write immutable `context.md` after spec/plan stabilize: objective, artifact paths/digests, repository/base ref, decisions, constraints, validation, escalation. Workers receive this bundle rather than parent transcript.

Each ticket states goal/dependencies, required inputs, owned and forbidden paths, expected output, exact validation executable/argv, acceptance, escalation, absolute approved worktree path, branch, worker/reviewer Herdr names/kinds/panes/session evidence, maximum fix rounds (default/max 2), and initial status `ready`. Keep dependent tickets serial; independent concurrent tickets require separate worktrees and non-overlapping ownership.

## 5. Request implementation approval

Present reviewed artifact paths, ticket count/batches, ownership, worktrees/panes, exact validation argv, models, fix bound, expected cost/latency, and blocked-decision behavior.

Approval authorizes only listed tickets through bounded validation/review. It does not authorize dependency additions, product/architecture changes, broader ownership, public API breaks, risky migrations, model changes, alternate execution, merge, cleanup, deployment, release, or publication. Stop and ask for those.

## 6. Execute approved tickets

First verify Herdr `0.9.5`, protocol `22`, and running compatible server. Package never installs, starts, or upgrades Herdr.

Call `delivery_start` once with:

```json
{
  "runId": "<run-id>",
  "baseSha": "<approved git sha>",
  "tickets": "<serialized approved ticket array>",
  "validation": { "executable": "npm", "args": ["test"] },
  "maxConcurrency": 2
}
```

Never pass shell text. Runtime validates full graph/contracts before exclusive run creation, launches dependency-ready batch, and fails closed. Herdr creates exact worktrees and starts worker Pi with model argv. Runner requires result-file pointer, captures Git evidence, runs validation, freezes candidate, and starts fresh reviewer with scoped nonce-bound `delivery_result_write`. Reviewer has read/grep/find/ls only plus scoped result tool. Same retained writer receives accepted findings, at most two rounds.

```text
ready → active → review → needs_fix → active → done
                         ↘ blocked
batch done → awaiting_integration
```

One writer owns each worktree. Never launch replacement while ownership uncertain.

## 7. Integrate and continue

When status is `awaiting_integration`, inspect ticket state, result pointers, validation logs, frozen patches, review result/candidate hash, and handoff manifests. Integrate only reviewed `done` lanes into clean parent checkout. Deleted paths are supported through path-bound absence sentinels and must be absent at integrated commit. Commit integration, rerun required checks as needed, then call:

```json
{ "runId": "<run-id>", "integratedSha": "<integrated sha>" }
```

through `delivery_continue`. Runtime verifies clean checkout, ancestry, exact content hashes or deletion sentinels, and configured validation before next batch/final state. Git errors, object-type mismatches, and content/deletion mismatches fail closed.

## 8. Supervise, recover, stop

Use tools or same-name JSON commands:

- `delivery_status` — durable phase and next action;
- `delivery_steer` — bounded guidance to exact active worker;
- `delivery_reply` — reserved API, currently rejected for normal blocked decisions because runtime does not persist `ticket.question`;
- `delivery_stop` — interrupt recorded worker only and wait for that worker to settle.

Do not instruct operators to use `delivery_reply` until question persistence exists. Resolve blocked decisions outside this control API. No sleep/poll loops.

Detached startup claims exclusive runner ownership and reconciles durable state before inbox processing or scheduling. Recovery uses only exact retained Herdr identity and candidate evidence; it never launches replacement worker/reviewer or model fallback. Exact settled reviewed results resume safely. Live, unknown, incomplete, ambiguous, or unavailable recovery blocks affected lanes and preserves evidence. Manual inspection and worktree cleanup remain operator duties.

`stopped` proves only recorded worker settled, not reviewer inactivity. `stop_unconfirmed` requires manual confirmation; never clean up or replace writer.

### Upgrade from legacy pi-subagents

Legacy runtime state is unsupported and read-only. Preserve evidence, settle old agents with old install, remove old dependency, install current package, verify Herdr, reload, and start new run. No migration or continuation.

Herdr worktree cleanup is always manual after final acceptance or abandonment. Before cleanup, manually verify recorded worker and every reviewer target and pane are inactive, inspect ownership evidence, and require clean worktree state. Preserve and reconcile dirty changes. Only then remove through operator/Herdr process, and delete runtime evidence only when no longer needed. Never infer cleanup safety from `stopped`.

## 9. Finish

Every ticket ends done, blocked, stopped, or stop_unconfirmed with named next action. Parent reports changed files, validation, independent review, handoff/evidence paths, integration verification, residual risks, blocked decisions, and available cost evidence. Parent performs final acceptance.

Automated tests use synthetic Herdr fixtures. Before release, require disposable live fixture evidence for status handshake, worker result, scoped review result, continuation, stop, and cleanup. Redact secrets/paths. Publication, merge, push, deploy, release, and tag require separate authority; this workflow performs none.
