# Workflow tutorial

## 1. Start from repository

Ensure clean Git state when implementation will use managed worktrees. Ensure scratch path is ignored:

```bash
printf '\n.scratch/\n' >> .gitignore
```

Use smallest direct flow for trivial work. For non-trivial objective:

```text
/delivery Add project-level API key rotation
```

## 2. Brainstorm requirements

Parent asks only unresolved product and contract questions. Good answers establish:

- user-visible behavior;
- compatibility constraints;
- security and data-integrity boundaries;
- non-goals;
- measurable acceptance criteria.

Parent writes `.scratch/<task>/spec.md`.

## 3. Review specification

Parent launches `delivery.review` with:

```json
{
  "kind": "spec",
  "artifact": ".scratch/<task>/spec.md",
  "contextBundle": ".scratch/<task>/context.md"
}
```

Reviewer starts fresh on Claude Opus 5.5 and cannot edit. Parent accepts, rejects, or escalates each finding. Product decisions return to user.

## 4. Build and review plan

Parent writes `.scratch/<task>/plan.md` with seams, ordering, files/contracts, failure handling, tests, rollout, and ticket split. Same reviewer checks feasibility and validation completeness with `kind: "plan"`.

Parent revises valid findings.

## 5. Freeze context bundle

Parent writes `.scratch/<task>/context.md`:

```markdown
# Objective
...

# Approved decisions
...

# Contracts
- Spec: spec.md (sha256: ...)
- Plan: plan.md (sha256: ...)

# Global constraints
...

# Validation conventions
...

# Escalation rules
...
```

Do not put raw transcript or secrets here.

## 6. Create tickets

Parent writes `tickets.json` and one Markdown file per ticket. See [ticket contract](ticket-contract.md).

Example batches:

```text
Batch 1: T001 schema contract, T002 UI copy (independent)
Batch 2: T003 integration (depends on T001, T002)
Batch 3: T004 end-to-end verification (depends on T003)
```

Parallel writers need separate managed worktrees and exclusive ownership.

## 7. Approve execution

Parent presents:

- reviewed artifact paths;
- ticket count and dependency batches;
- models and medium thinking;
- write ownership and isolation;
- exact validation gates;
- two-round fix ceiling;
- expected token/latency cost;
- conditions that block unattended work.

User approves once for listed plan. Scope changes need renewed approval.

## 8. Run tickets

Parent creates mission and launches `delivery.ticket` per dependency-ready ticket:

```json
{
  "workflow": "delivery.ticket",
  "args": {
    "ticketId": "T001",
    "ticketPath": ".scratch/key-rotation/tickets/T001.md",
    "contextBundle": ".scratch/key-rotation/context.md",
    "validationCommand": "npm test",
    "ownedFiles": ["src/keys.ts", "test/keys.test.ts"],
    "forbiddenFiles": ["package.json"],
    "isolated": true,
    "maxFixRounds": 2
  },
  "async": true,
  "cwd": "/path/to/repository",
  "missionId": "<mission-id>"
}
```

Supported validation forms include common `npm`, `pnpm`, `yarn`, `bun`, Node test runner, pytest, Cargo, Go, and .NET test commands. Shell operators are rejected.

## 9. Supervise

Inspect:

```text
/subagents-fleet
```

Guide live run:

```text
/subagents-steer <run-id> Focus on failing token replay test
```

Stop top-level async run:

```text
/subagents-stop <run-id>
```

Children ask parent when ticket requires unapproved decision. User can step away; normal async completion wakes originating session.

## 10. Integrate and accept

Managed worktree output is handoff evidence, not automatic merge. Parent:

1. inspects ticket state and reviewer result;
2. inspects handoff patch;
3. integrates only `done` ticket;
4. reruns integrated validation;
5. starts dependent batch;
6. reports final evidence and residual risks;
7. closes mission after final acceptance.

Push, merge, deploy, and release remain separate user-authorized actions.
