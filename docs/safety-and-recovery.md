# Safety and recovery

## Trust boundaries

Package extension runs inside Pi process with user OS permissions. Install only trusted revision. Project code and web content remain untrusted data.

Workflow resource arguments persist as evidence. Never put secrets in them.

Scratch artifacts must not contain:

- `.env` values;
- provider tokens;
- `auth.json`;
- MCP authentication data;
- session transcript dumps;
- unrelated private source or user data.

## Validation-command policy

`delivery.ticket` accepts narrow test commands and rejects shell syntax including newline, semicolon, pipes, redirection, substitution, and backslash.

Reason: trusted named workflow can grant host command authority. Freeform shell input would turn workflow arguments into command injection.

Compound validation belongs in a package script and uses structured `{ runner: "npm", script: "..." }`. Direct script paths remain rejected.

## Contract and output paths

Context and ticket inputs must resolve to regular UTF-8 files under repository `.scratch/`. Missing, binary, oversized, traversal, absolute, and symlink-escape inputs fail before child launch. Aggregate contract content is capped at 128 KiB.

`artifactOutputs` accepts at most 16 bounded relative `.scratch/` paths. Runtime rejects traversal, symlinks, non-files, missing files, and files over 50 MiB, then copies declared outputs to run-owned storage before managed worktree cleanup. Handoff manifest records requested-to-saved mappings.

## Unattended mutation boundary

One explicit approval covers only tickets and gates shown in reviewed plan. Worker stops for:

- dependency addition;
- product or architecture choice;
- broader ownership;
- public API break;
- destructive or irreversible migration;
- credentials or permissions;
- model tier escalation;
- failed provider/model requiring fallback;
- alternate execution mode;
- publication or deployment.

## Worktree rules

- Source checkout must be clean before managed worktree launch.
- One writer per checkout/worktree.
- Preserve worktree while run ownership, retained resume, review, or handoff is active.
- Integration and cleanup are parent operations.
- Dirty or unknown worktree is retained, never discarded automatically.

## Failure classes

### Reviewer says `needs_fix`

Parent/resource records state and resumes same writer. Maximum rounds defaults to 2 and cannot exceed 3.

### Reviewer says `blocked`

Ticket stops. Parent resolves decision or revises approved plan. Do not convert to implementation fix.

### Validation fails

Writer run fails gate. Inspect exact logs and head. Keep lane blocked until same-protocol retry or approved replacement.

### Provider/model fails

No fallback. Ask operator before choosing another model family or ID.

### Workflow infrastructure fails

Report exact run, cwd, ref, worktree, partial diff, and artifact status. Do not silently switch to shell, external CLI, foreground child, or another runner.

### Parent session closes

Detached child may finish, but completion wake needs originating live session. Recover from mission and exact run state after reopening.

## Recovery sequence

1. List/show relevant mission.
2. Inspect linked workflow run and child status.
3. Inspect transcript or artifact evidence.
4. Confirm worktree ownership and partial diff.
5. Resume only child reported eligible, or create one explicit replacement lane from durable handoff.
6. Update mission `nextReadyAction`.
7. Continue dependency-ready tickets.

## Operator commands

```text
/subagents-doctor
/subagents-fleet
/subagents-steer <run-id> <message>
/subagents-stop <run-id>
/subagent-cost
```

Use native notifications. Never add polling or sleep loops merely to watch ordinary async runs.
