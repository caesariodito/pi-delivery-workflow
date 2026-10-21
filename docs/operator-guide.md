# Operator guide

## Start

Reload Pi after installation, then run:

```text
/delivery <objective>
```

Small linear tasks stay direct. Non-trivial tasks follow:

```text
brainstorm → spec → fresh review → revise → plan → fresh review → revise
→ tickets → approval → isolated implementation → validation → fresh review
→ bounded fixes → parent acceptance
```

Reviewer model is `9router/cc/claude-opus-5-5`; parent and worker model is `9router/cx/gpt-5.6-sol`. All use medium thinking. Model failure blocks work; no automatic fallback occurs.

## Approval and safety

Discovery and review may run while preparing proposal. Implementation starts only after explicit plan-wide approval. Approved tickets may then run unattended through validation and at most two review/fix rounds.

Workflow stops for dependency additions, product or architecture choices, broader file ownership, public API breaks, risky migrations, model escalation, publication, or execution-mode fallback.

Concurrent writers require managed worktrees and clean source checkout. Parent integrates reviewed handoffs and retains final acceptance.

## Context and cost

Workers receive immutable `.scratch/<task>/context.md` plus ticket packet. This keeps prompts stable and inspectable. Native `context: "fork"` remains available by exception but forks current parent leaf; arbitrary earlier node-ID anchoring is unsupported.

Fresh Claude reviews intentionally miss GPT-family prompt cache. Stable worker bundles may improve cache reuse, but provider routing determines actual cache hits. Check combined usage with:

```text
/subagent-cost
```

More tickets and fix rounds increase latency and tokens. Keep tickets bounded and parallelize only independent seams.

## Supervision

```text
/subagents-fleet
/subagents-steer <run-id> <message>
/subagents-stop <run-id>
```

Children ask blocking questions through native supervisor messaging. Async completion wakes originating session; no polling needed.

Recover durable work through mission list/show, then inspect exact run status and resume eligible retained children. Infrastructure or provider failure remains blocked until operator chooses same-protocol retry or approves another mode.

## Artifacts

Human contracts live under ignored repository path:

```text
.scratch/<task>/spec.md
.scratch/<task>/plan.md
.scratch/<task>/context.md
.scratch/<task>/tickets.json
.scratch/<task>/tickets/<id>.md
```

Mission state stores ticket lifecycle. Never put credentials, auth files, MCP tokens, raw session transcripts, or unrelated private context in these files.

## Smoke test

Runs resolver and safety assertions only. No model calls, repository mutation, or child launch:

```bash
node ~/.pi/agent/extensions/delivery-workflow-smoke.mjs
```

Maintainer checks also type-check `delivery-workflow.ts` with root `tsconfig.json` and validate generated scripts through `subagent({ action: "validate" })`.
