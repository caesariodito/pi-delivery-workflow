# Ticket contract

Each ticket must be independently understandable and map to exact Herdr worktree/agent identities.

## Human ticket

```markdown
# T001 — Rotate stored API key

## Goal
One bounded observable outcome.

## Dependencies
- none

## Ownership
Owned: `src/keys.ts`, `test/keys.test.ts`
Forbidden: `package.json`, migrations

## Expected output
Behavior, focused regression test, changed-file and validation evidence.

## Validation
Executable `npm`, argv `["test"]`.

## Acceptance criteria
- old key remains valid during approved grace period
- replay after revocation is rejected

## Escalation
Dependency, schema, public API, security conflict, or broader ownership.

## Fix rounds
2
```

## Runtime ticket example

`delivery_start.tickets` is JSON string containing array:

```json
[
  {
    "id": "T001",
    "dependencies": [],
    "batch": 1,
    "ownedPaths": ["src/keys.ts", "test/keys.test.ts"],
    "forbiddenPaths": ["package.json"],
    "worktreePath": "/absolute/path/to/t001-worktree",
    "branch": "delivery/T001",
    "ticket": "Immutable approved ticket text",
    "context": "Immutable approved context bundle",
    "maxFixRounds": 2,
    "worker": { "name": "worker-T001", "kind": "pi", "pane": "workspace:1.1", "session": "worker-session" },
    "reviewer": { "name": "reviewer-T001", "kind": "pi", "pane": "workspace:1.2", "session": "review-session" },
    "artifactMappings": {}
  }
]
```

Top-level validation applies unless ticket supplies validated override:

```json
{ "executable": "npm", "args": ["run", "validate:t001"], "cwd": "packages/service" }
```

## Partition rules

Ticket valid when goal is one testable outcome, concurrent ownership/worktrees do not overlap, dependencies and batches are explicit, validation can fail changed behavior, identities are exact, worker need not invent decisions, and output yields Git-backed handoff. Keep tightly coupled seam together; do not manufacture parallelism.

## Lifecycle

| State | Meaning | Next action |
| --- | --- | --- |
| `ready` | Approved and dependencies met | Start sole writer |
| `active` | Exact Herdr writer owns worktree | Wait or bounded steer |
| `review` | Frozen candidate and passing validation exist | Fresh scoped review |
| `needs_fix` | Accepted bounded findings | Resume same writer |
| `done` | Clean review and handoff exist | Parent integration |
| `awaiting_integration` | Batch complete | Integrate and call `delivery_continue` |
| `blocked` | Decision/failure/ambiguity | Parent action |
| `stopped` | Recorded worker settled; reviewer inactivity unproven | Verify all worker/reviewer targets and panes, ownership, and clean worktree before manual cleanup |
| `stop_unconfirmed` | Recorded worker stop not proven | Confirm ownership; retain worktree |

`done` never comes from prose. Required evidence includes candidate hash, frozen patch, path hashes, validation log, scoped review result, and handoff manifest. Deleted paths use path-bound absence sentinels and pass continuation only when exact path is absent at integrated commit.
