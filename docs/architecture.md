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

- `extensions/delivery-workflow.ts` — `/delivery` and six bounded tools, including explicit cleanup.
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
8. Read Git status, reject paths outside ownership, capture a binary temporary-index patch plus SHA-256 digest, and write handoff.
9. Mark ticket `validation_passed`; launch text-only dependents or pause for exact parent integration.
10. At `delivery_continue`, reverse-check each validated patch against clean current parent HEAD before marking it `integrated`.
11. At explicit `delivery_cleanup`, recheck evidence/live identity, force-remove eligible Herdr worktrees, and mark them `cleaned`.

Context packet carries objective, goal, done criteria, paths, base, ownership, dependencies, concise handoffs, source-document pointers, validation, model/tools, guidance, result schema, and escalation rules.

## State

`run.json` and `status.json` are inspection records. Prompt, result, handoff, validation log, immutable patch, and digest metadata remain readable under ignored `.scratch/`. Patch evidence is written before `validation_passed`; integration evidence before `integrated`; cleanup evidence after confirmed removal. Records still are not a transactional journal. If orchestrator dies or removal succeeds before state persistence, operator inspects Herdr and evidence; package never replays ambiguous cleanup.

## Authority and limits

Parent owns product/architecture decisions, ticket approval, integration, explicit cleanup invocation, and publication. Package may launch approved ready tickets, validate, verify exact integration, and remove only evidence-backed integrated worktrees after `delivery_cleanup`. It never merges, applies patches, deletes branches/runtime evidence, changes model/provider, installs dependencies, or replays ambiguous actions.

Worktrees isolate writers from each other, not from user OS. Package checks Git ownership; it does not claim filesystem sandboxing.
