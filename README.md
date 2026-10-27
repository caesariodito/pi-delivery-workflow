# pi-delivery-workflow

Visible, supervised ticket delivery for Pi through Herdr.

Package keeps `/delivery`, turns an approved dependency graph into bounded context packets, launches ready Pi agents in separate Herdr worktrees, runs ticket validation, and records concise handoffs. Herdr remains inspection/control surface. Parent remains authority for decisions, integration, cleanup, and publication.

Small linear work stays direct.

## Requirements

- Pi `1.3.0` or compatible current release
- Node.js and Git
- Herdr `0.9.5`, protocol `22`, running server
- `HERDR_ENV=1`
- configured approved Pi models
- clean parent checkout
- ignored `.scratch/`

Package does not install, start, or upgrade Herdr. Missing or unknown state blocks. No model fallback.

## Install

```bash
pi install git:github.com/caesariodito/pi-delivery-workflow
herdr --version
herdr status --json
```

Restart Pi or run `/reload`.

## Start

```text
/delivery Add refresh-token rotation
```

After plan/ticket approval, call `delivery_start` with object fields:

- `runId`, `objective`, exact `baseSha`;
- normalized absolute `worktreeRoot` naming an existing real directory outside repository;
- `contextPaths` referencing relevant approved files;
- `maxConcurrency` from 1–8;
- ticket array described in [ticket contract](docs/ticket-contract.md).

`delivery_start` stays attached to current Pi process while batch runs. It launches all dependency-ready tickets up to concurrency, waits for Herdr settlement, validates results, writes handoffs, then launches newly ready textual dependencies. Tickets needing integrated code pause at `awaiting_integration`.

## Tools

| Tool | Behavior |
| --- | --- |
| `delivery_start` | Run approved graph visibly in current Pi process |
| `delivery_status` | Read persisted inspection status |
| `delivery_steer` | Prompt exact currently active agent |
| `delivery_continue` | Continue after parent supplies clean integrated HEAD |
| `delivery_stop` | Send `Ctrl+C`; retain pane/worktree |

Same-name slash commands accept JSON. `/delivery` accepts free text.

## Runtime evidence

```text
.scratch/delivery/<run-id>/
  run.json
  status.json
  prompts/<ticket>.md
  results/<ticket>.json
  handoffs/<ticket>.json
  logs/<ticket>.log
```

This state supports inspection, not transparent crash recovery. If Pi/workflow dies, inspect retained Herdr agents and worktrees. Start a new supervised run if needed. Never replay an ambiguous prompt or external action automatically.

## Execution rules

- Herdr creates visible worktree/pane and starts exact approved model/tools.
- Each agent receives one bounded Markdown context packet.
- One writer owns each worktree; ticket ownership cannot overlap.
- Agent writes one nonce-bound result through scoped `delivery_result_write`.
- Git determines changed paths; agent claims are advisory.
- Validation uses executable plus argv with `shell: false`.
- Blocked, failed, unknown, or timed-out work retains pane/worktree.
- No automatic reviewer/fix loop in core scheduler.
- No automatic merge, patch application, cleanup, push, publish, deploy, or release.

## Integration

At `awaiting_integration`, parent inspects branches, worktrees, changed paths, validation, and handoffs. Parent integrates accepted work manually and commits. Then:

```text
/delivery_continue {"runId":"refresh-token","integratedSha":"<current-clean-head>"}
```

Dependent tickets start with concise dependency handoffs and supplied base. Tickets consuming textual handoffs can run before code integration when `requiresIntegratedBase` is `false`.

## Failure behavior

- blocked worker: preserve pane/worktree and report question;
- failed validation: preserve pane/worktree and log;
- unknown Herdr state or missing result: block without replay/replacement;
- parent-process death: no daemon takeover or phase recovery;
- timeout: block; package does not kill or replace agent automatically;
- stop: request interrupt, then operator verifies actual state.

## Validation

```bash
npm install
npm run check
npm pack --dry-run
```

Automated tests use synthetic Herdr fixtures. Release requires one disposable live fixture proving two visible parallel agents, distinct context packets, result collection, validation, dependency handoff, and retained worktrees. Publication needs separate authority.

## Documentation

- [Operator guide](docs/operator-guide.md)
- [Architecture](docs/architecture.md)
- [Tutorial](docs/tutorial.md)
- [Ticket contract](docs/ticket-contract.md)
- [Safety](docs/safety-and-recovery.md)
- [Development](CONTRIBUTING.md)

## License

MIT
