# pi-delivery-workflow

Visible, supervised ticket delivery for Pi through Herdr.

Package keeps `/delivery`, turns an approved dependency graph into bounded context packets, launches ready Pi agents in separate Herdr worktrees, runs bounded validation, and records inspection evidence. Herdr remains inspection/control surface. Parent remains authority for decisions, review disposition, integration, cleanup, and publication. Small linear work stays direct.

## Requirements

- Pi `1.3.0` or compatible current release
- Node.js and Git
- Herdr `0.9.5`, protocol `22`, running server
- `HERDR_ENV=1`
- configured approved Pi models
- clean parent checkout
- ignored `.scratch/`

Package does not install, start, or upgrade Herdr. Missing, contradictory, or unknown state blocks. No model fallback.

## Install

```bash
pi install git:github.com/caesariodito/pi-delivery-workflow
herdr --version
herdr status --json
```

Restart Pi or run `/reload` only when no delivery run is active or awaiting integration/cleanup.

## Start

```text
/delivery Add refresh-token rotation
```

After plan/ticket approval, use `delivery_preview`, then call `delivery_start` with `runId`, objective, exact `baseSha`, approved context paths, concurrency `1..8`, optional integration validation, and tickets from [ticket contract](docs/ticket-contract.md). `worktreeRoot` is optional: omission selects a private persistent repository-specific root under `~/.pi/delivery-worktrees/v1`; an explicit normalized absolute existing writable real directory outside the repository remains supported. No temporary fallback exists.

New runs persist canonical resolved root and `derived` or `override` provenance before launch; later runtime operations reuse that evidence rather than rederive it. `.scratch/` stores evidence only, never worktrees.

Runtime uses an event-driven pool: ready tickets fill free slots; each settlement is persisted; first non-success stops new launch while already-active tickets drain. Tickets needing integrated code pause at `awaiting_integration`.

## Tools

| Tool | Behavior |
| --- | --- |
| `delivery_preview` | Validate/render graph, gates, warnings, limits, and critical path without launch |
| `delivery_start` | Run approved graph visibly in current Pi process |
| `delivery_status` | Read lifecycle, review verdicts, retained resources, metrics, and next action |
| `delivery_reconcile` | Read-only comparison of persisted, Herdr, evidence, and Git state |
| `delivery_steer` | Prompt exact currently active agent |
| `delivery_continue` | Verify exact integrated patches, run optional integration validation, then continue |
| `delivery_dispose` | Record parent disposition for reviewed ticket |
| `delivery_cleanup` | Explicitly remove eligible integrated Herdr worktrees; preserve branches/evidence |
| `delivery_stop` | Send `Ctrl+C`; retain pane/worktree |

Same-name slash commands accept JSON. `/delivery` accepts free text.

## Evidence and limits

Evidence lives under `.scratch/delivery/<run-id>/`: run/status JSON, prompts, nonce-bound results, handoffs, logs, patches, and patch metadata. This supports inspection, not transparent crash recovery.

- One writer per worktree; ownership cannot overlap.
- Commands are executable plus argv with `shell: false`.
- Git determines changed paths; result claims remain advisory.
- Herdr wait calls remain at most 300 seconds; longer ticket deadlines use repeated waits.
- Ticket timeout retains workspace without kill or replacement.
- Validation timeout is a failure. An approved `maxFixRounds: 1` permits one same-agent, same-worktree repair with fresh immutable evidence.
- Review workers receive `read` only plus scoped result writer. Git snapshots detect mutation but do not create an OS sandbox.
- No automatic merge, patch application, replay, replacement, review acceptance, cleanup, push, publish, deploy, or release.

## Integration and review

Parent inspects output, manually integrates accepted work, commits, then calls:

```text
/delivery_continue {"runId":"refresh-token","integratedSha":"<current-clean-head>"}
```

Exact persisted patch must reverse-apply at supplied clean HEAD. Optional integration validation runs before downstream launch.

Review verdicts are `approve`, `changes_requested`, or `blocked`; findings remain open evidence until parent calls `delivery_dispose`. Only approved disposed reviews can unblock dependencies and become cleanup-eligible. Parent disposition belongs to the supervisor, not necessarily the human: [triage findings](docs/operator-guide.md#supervisor-triage-policy) within existing authority; ask the human for unresolved uncertainty or expanded authority. This adds no repair rounds or automatic retries.

After final acceptance:

```text
/delivery_cleanup {"runId":"refresh-token"}
```

See [operator guide](docs/operator-guide.md) for interruption, reconcile, timeout/fix, metrics, integration, review, cleanup, and publication playbooks.

## Validation

```bash
npm install
npm run check
npm pack --dry-run
```

Publication always needs separate authority.

## Documentation

- [Operator guide](docs/operator-guide.md)
- [Architecture](docs/architecture.md)
- [Tutorial](docs/tutorial.md)
- [Ticket contract](docs/ticket-contract.md)
- [Safety and recovery](docs/safety-and-recovery.md)
- [Development](CONTRIBUTING.md)

## License

MIT
