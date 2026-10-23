# pi-delivery-workflow

Reviewed spec-to-ticket delivery for [Pi](https://github.com/earendil-works/pi), with Herdr-managed worktrees and agents.

```text
brainstorm → spec → fresh review → revise → plan → fresh review → revise
→ bounded tickets → explicit approval → isolated workers → validation
→ fresh review → bounded fixes → parent integration and acceptance
```

Package adds `/delivery <objective>`, seven `delivery_*` tools and matching JSON-argument commands, detached runner, scoped reviewer-result tool, and delivery skill. Parent Pi session retains requirements, decisions, finding disposition, integration, final acceptance, and publication authority.

Small linear tasks remain direct.

## Requirements

- Pi `1.3.0` or compatible current release
- Node.js supported by Pi
- Git
- Herdr `0.9.5`, protocol `22`, executable as `herdr`
- running compatible Herdr server
- configured models:
  - worker: `9router/cx/gpt-5.6-sol`
  - reviewer: `9router/cc/claude-opus-5-5`

Model constants live in `extensions/delivery-workflow-core.mjs`. Missing or incompatible Herdr, model failures, and provider failures block work. No silent fallback.

## Install

```bash
pi install git:github.com/caesariodito/pi-delivery-workflow
herdr --version
herdr status --json
```

Restart Pi or run `/reload`. Package does not install or start Herdr.

## Quick start

```text
/delivery Add refresh-token rotation with replay detection
```

Pi classifies request as direct, workflow candidate, or uncertain. Workflow candidates may use `delivery_review` during discovery. Implementation waits for explicit plan-wide approval.

### Tool and command surface

| Operation | Tool / command |
| --- | --- |
| Fresh spec, plan, or implementation review | `delivery_review` |
| Start approved detached run | `delivery_start` |
| Read durable state | `delivery_status` |
| Guide active ticket | `delivery_steer` |
| Reserved blocked-ticket reply API (currently unavailable) | `delivery_reply` |
| Continue after verified parent integration | `delivery_continue` |
| Request worker stop without cleanup | `delivery_stop` |

Model-callable tools take JSON objects. Slash-command wrappers use same names and require one JSON object after command name. `/delivery` alone accepts free-text objective.

Example start shape:

```json
{
  "runId": "refresh-token",
  "baseSha": "0123456789012345678901234567890123456789",
  "tickets": "[{\"id\":\"T001\",\"dependencies\":[],\"batch\":1,\"ownedPaths\":[\"src/token.ts\"],\"worktreePath\":\"/absolute/path/to/worktree\",\"branch\":\"delivery/T001\",\"ticket\":\"Approved ticket text\",\"context\":\"Immutable approved context\",\"forbiddenPaths\":[],\"maxFixRounds\":2,\"worker\":{\"name\":\"worker-T001\",\"kind\":\"pi\",\"pane\":\"workspace:1.1\",\"session\":\"worker-session\"},\"reviewer\":{\"name\":\"reviewer-T001\",\"kind\":\"pi\",\"pane\":\"workspace:1.2\",\"session\":\"review-session\"},\"artifactMappings\":{}}]",
  "validation": { "executable": "npm", "args": ["test"] },
  "maxConcurrency": 1
}
```

`delivery_start` accepts executable plus argv, never shell text. Ticket JSON must carry approved absolute worktree paths and Herdr pane identities prepared by parent/operator. Runtime sends Pi setup as discrete agent argv (`--model`; reviewer also receives `--extension`, nonce-bound result flags, and `--tools`).

## Artifacts and lifecycle

Human contracts:

```text
.scratch/<task>/spec.md
.scratch/<task>/plan.md
.scratch/<task>/context.md
.scratch/<task>/tickets.json
.scratch/<task>/tickets/<id>.md
```

Runtime evidence:

```text
.scratch/delivery/<run-id>/
```

Repository must ignore `.scratch/`. Runtime records prompts, result pointers, validation logs, frozen patches, ticket state, control inbox receipts, and handoff manifests with restrictive permissions.

```text
ready → active → review → needs_fix → active → done
                         ↘ blocked
batch done → awaiting_integration → delivery_continue → next batch/final acceptance
```

Parent integrates only reviewed `done` handoffs, commits integration, then calls `delivery_continue` with integrated SHA. Runtime verifies clean checkout, ancestry, exact path hashes, and validation before releasing dependent batch. Current integration verification cannot accept deleted paths because it expects `git show <sha>:<path>` content. If a handoff deletes any path, do not integrate or call `delivery_continue`; leave run blocked, preserve evidence, and escalate. Deletion support is pending.

## Supervision and recovery

Use `delivery_status` for current phase and next action. Use `delivery_steer` only for bounded guidance to exact active ticket. `delivery_reply` remains registered for future question persistence, but current runtime never records `ticket.question`; normal blocked-decision replies are rejected. Do not instruct operators to use it. `delivery_stop` interrupts only recorded worker and waits for that worker to settle; it does not stop or prove inactivity of any reviewer. `stop_unconfirmed` requires manual inspection.

Pi reload does not restart or reconcile a dead detached runner. If runner is missing or has died, state may remain `active` and control inbox requests will not be consumed. Treat run as blocked: do not send controls, integrate, or call `delivery_continue`; preserve state, receipts, Herdr agent/worktree evidence, patches, and handoffs, then escalate. Never launch fallback or replacement writer while ownership remains uncertain. Exact-settled recovery logic exists only as an internal unit-tested seam and is not wired into detached entry.

Herdr worktrees are retained. Cleanup is always manual after acceptance or abandonment:

1. inspect status, patch, handoff, and Git ownership evidence;
2. manually verify recorded worker and every reviewer target and pane are inactive;
3. require clean worktree state; if dirty, preserve and reconcile changes before deliberately cleaning it;
4. remove worktree with Herdr/operator workflow;
5. remove `.scratch/delivery/<run-id>/` only after preserving needed evidence.

No automatic cleanup, merge, push, deploy, release, or publication.

## Upgrade from legacy installs

Runs created by legacy pi-subagents versions are unsupported. Existing `.scratch/pi-subagents` or `.pi/subagents` data is detected read-only; control and continuation refuse it. Preserve legacy evidence, finish or stop old agents with old installation, remove old package dependency, reinstall this package, verify Herdr `0.9.5` protocol `22`, reload Pi, then start new run. No state migration exists.

## Validation status

Automated tests use mocked Herdr contracts and launch no models. Maintainer release evidence must also include manual disposable-repository live fixture against exact supported Herdr version: status handshake, one worker result, one scoped review result, integration continuation, stop behavior, retained-worktree cleanup, and redacted logs. Current compatibility fixture is synthetic; publication remains prohibited until live evidence and separate release authority exist.

```bash
npm install
npm run check
npm pack --dry-run
```

## Documentation

- [Operator guide](docs/operator-guide.md)
- [Architecture](docs/architecture.md)
- [Workflow tutorial](docs/tutorial.md)
- [Ticket contract](docs/ticket-contract.md)
- [Safety and recovery](docs/safety-and-recovery.md)
- [Development](CONTRIBUTING.md)

## License

MIT
