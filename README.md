# pi-delivery-workflow

Reviewed spec-to-ticket delivery for [Pi](https://github.com/earendil-works/pi), built on native [`pi-subagents`](https://github.com/nicobailon/pi-subagents) primitives.

```text
brainstorm
  ↓
spec.md → fresh different-family review → revised spec.md
  ↓
plan.md → fresh different-family review → revised plan.md
  ↓
bounded tickets → explicit approval
  ↓
isolated workers → validation gates → fresh review → bounded fixes
  ↓
parent acceptance
```

Package adds `/delivery <objective>`, trusted workflow resources, and a skill that keeps requirements, decisions, finding disposition, and final acceptance with parent Pi session.

## Why

Subagents help most through context isolation, independent evidence, and safe parallelism—not simulated organizations. This workflow keeps each child bounded:

- fresh reviewers inspect artifacts without implementation-history bias;
- one writer owns each checkout or managed worktree;
- tickets carry explicit ownership, validation, acceptance, and escalation rules;
- native missions preserve lifecycle and recovery state;
- native async completion replaces polling;
- supervisor messaging handles decisions instead of child-to-child chatter.

Small linear tasks remain direct.

## Requirements

- Pi `1.3.0` or compatible current release
- `pi-subagents` `0.76.1`
- configured models matching defaults:
  - parent/worker: `9router/cx/gpt-5.6-sol`
  - reviewer: `9router/cc/claude-opus-5-5`

Model constants currently live in `extensions/delivery-workflow-core.mjs`. Change them before installation if your registry uses other IDs. Model failures block work; package never silently falls back.

## Install

```bash
pi install git:github.com/caesariodito/pi-delivery-workflow
```

Restart Pi or run:

```text
/reload
```

Confirm setup:

```text
/subagents-doctor
```

## Quick start

```text
/delivery Add refresh-token rotation with replay detection
```

Pi first classifies request:

- **Direct** — small and linear; no workflow ceremony.
- **Workflow candidate** — reviewed spec/plan and ticket execution help materially.
- **Uncertain** — Pi asks user which mode to use.

For workflow candidates, discovery and review may run while preparing proposal. Implementation waits for one explicit plan-wide approval. Approved tickets can then run unattended through bounded validation and review gates.

## Artifacts

Workflow writes human contracts under ignored repository scratch path:

```text
.scratch/<task>/spec.md
.scratch/<task>/plan.md
.scratch/<task>/context.md
.scratch/<task>/tickets.json
.scratch/<task>/tickets/<id>.md
```

Add this before first run if repository does not already ignore it:

```gitignore
.scratch/
```

Mission state stores runtime lifecycle:

```text
ready → active → review → needs_fix → active → done
                         ↘ blocked
```

`blocked` protects product, architecture, security, dependency, migration, provider, and infrastructure decisions from unattended guessing.

## Safety boundary

Plan-wide approval does **not** authorize:

- dependency additions;
- unreviewed product or architecture changes;
- broader file ownership;
- public API breaks;
- risky data migrations;
- model thinking above medium;
- model or execution-mode fallback;
- push, merge, deployment, or release.

Those stop and return to parent/user.

## Context and prompt caching

Workers receive immutable `.scratch/<task>/context.md` before ticket details. Stable bundle gives explicit, inspectable shared prefix and may improve provider KV-cache reuse.

Native `context: "fork"` remains available when transcript inheritance is essential, but pi-subagents forks current persisted parent leaf. It cannot pin arbitrary earlier message-tree node ID. Package avoids custom session surgery until measured cache evidence justifies that seam.

Fresh Claude-family reviewers intentionally use separate context and model family.

## Supervision

```text
/subagents-fleet
/subagents-steer <run-id> <message>
/subagents-stop <run-id>
/subagent-cost
```

Children ask parent through native supervisor channel for blocking decisions. Async completion wakes originating session. Recovery uses mission list/show, exact run status, and eligible retained-child resume.

## Documentation

- [Operator guide](docs/operator-guide.md)
- [Architecture](docs/architecture.md)
- [Workflow tutorial](docs/tutorial.md)
- [Ticket contract](docs/ticket-contract.md)
- [Safety and recovery](docs/safety-and-recovery.md)
- [Development](CONTRIBUTING.md)

## Test

```bash
npm install
npm run check
```

Smoke test uses mocked workflow helpers. It launches no models and changes no project code.

## Inspiration

Workflow was inspired by m3umax's spec → different-model review → plan → review → ticket orchestration described in [this PiCodingAgent discussion](https://www.reddit.com/r/PiCodingAgent/comments/1t6zzwv/do_subagents_really_matter/). This package is an independent implementation using public Pi and pi-subagents APIs; no endorsement implied.

## License

MIT
