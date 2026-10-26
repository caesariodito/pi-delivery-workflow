# Architecture

## Shape

```text
Pi parent
  ├─ validates approved ticket graph
  ├─ writes bounded ticket context packets
  ├─ launches ready work through Herdr
  ├─ waits for result and runs validation
  ├─ records concise handoff
  └─ pauses for parent integration when needed

Herdr
  └─ owns visible worktrees, panes, and agent processes
```

No package daemon exists. Package does not reproduce pi-subagents missions, journals, takeover, automatic reviewer loops, or transparent recovery.

## Components

- `extensions/delivery-workflow.ts` — `/delivery` and five bounded tools.
- `extensions/delivery-workflow-core.mjs` — attached orchestration, status, steer, stop, continuation.
- `extensions/lib/scheduler.mjs` — graph validation, readiness, context packet generation.
- `extensions/lib/herdr.mjs` — argv-only Herdr CLI adapter for baseline `0.9.5`, protocol `22`.
- `extensions/reviewer-result-tool.ts` — nonce-bound ticket result writer.

## Ticket execution

1. Verify clean parent checkout and exact base SHA.
2. Create visible Herdr worktree and pane.
3. Write `.scratch/delivery/<run>/prompts/<ticket>.md`.
4. Start approved Pi model/tools in returned pane.
5. Prompt agent with context-packet path.
6. Wait for settled Herdr state and nonce-bound result file.
7. Run ticket validation with executable/argv and `shell: false`.
8. Read Git status, reject paths outside ownership, and write handoff.
9. Launch newly ready tickets or pause for parent integration.

Context packet carries objective, goal, done criteria, paths, base, ownership, dependencies, concise handoffs, source-document pointers, validation, model/tools, guidance, result schema, and escalation rules.

## State

`run.json` and `status.json` are inspection records. Prompt, result, handoff, and validation log remain readable under ignored `.scratch/`. They are not a transactional journal. If orchestrator dies, state may describe interrupted work; operator inspects Herdr and chooses a new supervised run.

## Authority and limits

Parent owns product/architecture decisions, ticket approval, integration, cleanup, and publication. Package may launch approved ready tickets and validation. It never merges, applies patches, cleans panes/worktrees, changes model/provider, installs dependencies, or replays ambiguous actions.

Worktrees isolate writers from each other, not from user OS. Package checks Git ownership; it does not claim filesystem sandboxing.
