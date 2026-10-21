# Ticket contract

Each ticket must be independently understandable by fresh worker.

## Markdown template

```markdown
# T001 — Rotate stored API key

## Goal
One bounded observable outcome.

## Dependencies
- none

## Required inputs
- `.scratch/key-rotation/context.md`
- relevant existing contract paths

## Ownership
Owned files/contracts:
- `src/keys.ts`
- `test/keys.test.ts`

Forbidden files:
- `package.json`
- database migrations

## Expected output
- rotation behavior
- focused regression test
- changed-file and validation evidence

## Validation
`npm test`

## Acceptance criteria
- old key remains valid during approved grace period
- replay after revocation is rejected
- no unrelated auth behavior changes

## Escalation conditions
- dependency addition needed
- persistent schema change needed
- public API must change
- security behavior conflicts with spec

## Fix rounds
2
```

## `tickets.json` example

```json
{
  "version": 1,
  "tickets": [
    {
      "id": "T001",
      "title": "Rotate stored API key",
      "path": ".scratch/key-rotation/tickets/T001.md",
      "dependencies": [],
      "batch": 1,
      "ownedFiles": ["src/keys.ts", "test/keys.test.ts"],
      "forbiddenFiles": ["package.json"],
      "validationCommand": "npm test",
      "isolated": true,
      "maxFixRounds": 2,
      "status": "ready"
    }
  ]
}
```

## Partition rules

Ticket is valid when:

- goal is one testable outcome;
- ownership does not overlap concurrent ticket;
- dependency list is explicit;
- validation can fail for changed behavior;
- worker can stop without inventing product decisions;
- output produces durable handoff.

Keep tightly coupled seam in one ticket. Split multi-seam work by independently testable contract. Do not manufacture parallelism.

## Lifecycle

| State | Meaning | Next action |
| --- | --- | --- |
| `ready` | Dependencies satisfied; approved to start | Launch sole writer |
| `active` | Writer owns checkout/worktree | Wait, steer, or answer decision |
| `review` | Candidate and validation evidence exist | Fresh review |
| `needs_fix` | Bounded actionable findings accepted | Resume retained writer |
| `done` | Validation and fresh review clean | Parent integration/acceptance |
| `blocked` | Decision, infrastructure, provider, scope, or fix-limit issue | Parent/user action |

Never infer `done` from child prose alone.
