---
name: delivery-workflow
description: Design and deliver non-trivial implementation through reviewed specs, plans, bounded tickets, isolated workers, and fresh review gates. Use when `/delivery` asks for this workflow or when user explicitly requests reviewed ticket-based unattended implementation.
---

# Delivery workflow

Parent owns requirements, decisions, finding disposition, final acceptance, and publication. Native `pi-subagents` owns execution, missions, worktrees, gates, control, and recovery.

## 1. Classify

Before implementation classify work:

- **Direct** — small, linear, well-understood. Work directly; do not force this workflow.
- **Workflow candidate** — reviewed specification, multiple bounded seams, fresh review, isolation, or unattended execution materially helps.
- **Uncertain** — ask user which mode to use.

Delegation authorization covers discovery and review needed to prepare spec/plan. It does not authorize implementation. Obtain one explicit plan-wide approval after reviewed tickets and execution proposal exist.

## 2. Prepare artifact root

Find repository root. Confirm `.scratch/` is ignored before writing. Use `.scratch/<task>/` with a filesystem-safe task slug. Never copy credentials, raw session history, auth files, MCP tokens, or unrelated private context.

Create durable human artifacts:

- `spec.md`
- `plan.md`
- `context.md`
- `tickets.json`
- `tickets/<id>.md`

Use mission state only for runtime lifecycle and recovery. Artifacts remain human-readable contracts.

## 3. Brainstorm and review specification

Brainstorm requirements with user. Parent writes `spec.md` containing problem, goals, non-goals, behavior, contracts, constraints, acceptance criteria, and open decisions.

Review with named workflow resource:

```text
subagent({
  workflow: "delivery.review",
  args: {
    kind: "spec",
    artifact: ".scratch/<task>/spec.md",
    contextBundle: ".scratch/<task>/context.md"
  },
  async: true,
  cwd: "<repo>"
})
```

Resource uses fresh `9router/cc/claude-opus-5-5` reviewer at medium thinking. Reviewer is read-only and returns structured actionable findings. Parent classifies every finding as valid, stale, invalid, speculative, or blocked, then revises accepted findings. Ask user about product or architecture decisions.

## 4. Plan, review, and ticket

Parent writes `plan.md`: seams, contracts/files, ordering, failure handling, validation, rollout risk, and ticket boundaries. Run same fresh review with `kind: "plan"`, then revise accepted findings.

Write immutable `context.md` after spec and plan stabilize. Put approved objective, artifact paths and digests, repository/ref, decisions, constraints, validation conventions, and escalation rules first. Workers receive this stable bundle rather than full parent transcript. Use `context: "fork"` only when inherited history is essential; native fork uses current parent leaf and cannot pin an arbitrary earlier node.

Split plan into bounded tickets. Each `tickets/<id>.md` must state:

- goal and dependencies;
- owned files/contracts and forbidden files;
- required inputs and expected output;
- exact validation command;
- acceptance criteria;
- escalation conditions;
- maximum fix rounds, default 2.

`tickets.json` records IDs, dependencies, batch, paths, validation, ownership, isolation, and status `ready`. Keep dependent tickets serial. Independent mutation tickets require managed worktrees.

## 5. Request implementation approval

Present reviewed spec/plan paths, ticket count and batches, write ownership, validation gates, reviewer and worker models, fix-round bound, expected cost/latency, and blocked-decision behavior.

Ask explicit plan-wide approval. Approval authorizes listed tickets to run unattended through bounded validation and review. It does not authorize dependency additions, product/architecture changes, model tier above medium, public API breaks, migrations with data risk, publication, merge, deployment, broader write scope, or execution-mode fallback. Stop and ask for those.

## 6. Execute approved tickets

Create one mission for full delivery and attach every ticket workflow with its `missionId`. Initialize mission state keys `ticket-<id>` and `nextReadyAction`.

For each dependency-ready batch, launch one `delivery.ticket` workflow per ticket. Use one coordinated top-level workflow when several tickets start together. Each ticket invocation supplies only plain non-secret args:

```text
workflow: "delivery.ticket"
args: {
  ticketId,
  ticketPath,
  contextBundle,
  validationCommand,
  ownedFiles,
  forbiddenFiles,
  isolated,
  maxFixRounds
}
async: true
cwd: <repo>
missionId: <mission>
```

State transitions:

```text
ready → active → review → needs_fix → active → done
                         ↘ blocked
```

`delivery.ticket` uses GPT 5.6 Sol worker, host validation gate, fresh Claude Opus 5.5 structured reviewer, retained bounded fix passes where available, and fail-closed blocked state. One writer owns each checkout/worktree. Never start replacement writer while ownership is uncertain.

After isolated work finishes, inspect returned handoff manifests. Parent integrates only reviewed `done` lanes, records durable handoff evidence, reruns required integrated validation, and performs final acceptance. Worktree cleanup remains separately reviewed and confirmed.

## 7. Supervise and recover

Use native completion notifications; no sleep or polling loops. Yield when only async work remains.

Children use `contact_supervisor` only for decisions, structured input, or meaningful progress. Parent replies with `subagent_supervisor`. No freeform child-to-child chatter.

Operator controls:

```text
/subagents-fleet
/subagents-steer <run-id> <message>
/subagents-stop <run-id>
```

Recover after restart or compaction with mission list/show, exact run status, then resume eligible retained child. Provider or orchestration infrastructure failure blocks lane; never switch models or execution modes silently.

## 8. Finish

Every ticket ends `done` or `blocked` with named next action. Parent reports changed files, validation, independent review, handoff paths, residual risks, blocked decisions, and cost from `/subagent-cost`. Close mission only after integrated evidence passes. Publication needs separate authority.
