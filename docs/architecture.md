# Architecture

## Design goal

Provide one repeatable path from ambiguous objective to reviewed implementation while keeping Pi parent authoritative and using native pi-subagents runtime.

## Components

### Extension

`extensions/delivery-workflow.ts` registers:

- `/delivery` command, which sends structured discovery prompt to parent session;
- `delivery.review`, trusted named workflow resource;
- `delivery.ticket`, trusted named workflow resource.

Extension owns no daemon, scheduler, database, subprocess manager, or alternate child lifecycle.

### Workflow core

`extensions/delivery-workflow-core.mjs` validates plain JSON resource arguments and returns bounded workflow scripts.

`delivery.review` launches one fresh, read-only reviewer with structured output:

```json
{
  "verdict": "ok | needs_fix | blocked",
  "findings": [
    {
      "severity": "P0 | P1 | P2",
      "location": "artifact section or file:line",
      "problem": "concrete issue",
      "action": "smallest actionable correction"
    }
  ],
  "summary": "bounded synthesis"
}
```

`delivery.ticket`:

1. records ticket `active` in mission state;
2. launches worker, optionally in managed worktree;
3. runs allowlisted host validation gate;
4. records `review`;
5. launches fresh structured reviewer;
6. records `done`, `blocked`, or `needs_fix`;
7. resumes retained writer for accepted findings;
8. stops after configured fix-round ceiling.

### Skill

`skills/delivery-workflow/SKILL.md` defines parent protocol: classification, artifacts, spec/plan review, ticket generation, approval, batching, integration, supervision, recovery, and final acceptance.

## Native capability mapping

| Need | Native primitive |
| --- | --- |
| Ordered orchestration | Workflow scripts and named resources |
| Background work | Async workflows and completion notifications |
| Durable objective | Mission |
| Ticket lifecycle | Mission `state.get/set` |
| Independent writers | Managed worktrees |
| Verification | Host gates and acceptance evidence |
| Independent critique | Fresh reviewer child |
| Fix continuation | Retained child resume |
| Human decision | `contact_supervisor` / `subagent_supervisor` |
| Operations | Fleet, status, steer, stop, resume |

## Authority model

Parent controls requirements, product/architecture decisions, finding disposition, integration, final acceptance, and publication.

Worker controls implementation choices inside one approved ticket and ownership boundary.

Reviewer is read-only and supplies evidence, not authority.

Mission receipts, tests, and clean reviews remain evidence—not permission to publish.

## Context strategy

Stable `context.md` bundle is immutable after approval. Every worker reads same bundle first, then ticket. Benefits:

- explicit and inspectable contract;
- no dependency on hidden parent transcript;
- stable prefix for possible cache reuse;
- safe fresh review.

Native fork context remains optional. Current public pi-subagents API forks current parent leaf, not arbitrary earlier session node. Package deliberately avoids private session APIs.

## Why named resources

Named workflow resources provide trusted provenance and bounded input validation. Public arguments cannot inject workflow code or arbitrary host commands. Validation command accepts only fixed test-runner shapes and rejects shell operators.

Current command allowlist is intentionally narrow. Add argv-style structured fields if projects need richer flags; never concatenate arbitrary shell text.

## Limits

- No arbitrary message-tree anchor.
- No automatic model fallback.
- No automatic patch integration or worktree cleanup.
- No automatic publication.
- One ticket resource handles one ticket; parent batches dependency-ready tickets.
- Review cannot prove correctness; parent still evaluates evidence.
