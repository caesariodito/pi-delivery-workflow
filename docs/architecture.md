# Architecture

## Shape

```text
Pi parent
  ├─ previews and validates approved graph
  ├─ writes bounded context packets
  ├─ fills ready slots through Herdr
  ├─ reconciles waits, validates, and records evidence
  ├─ pauses at integration/review gates
  └─ exposes read-only status, metrics, and reconcile

Herdr
  └─ owns visible worktrees, panes, and agent processes
```

No package daemon exists. Package does not reproduce mission takeover, automatic reviewer loops, or transparent recovery.

## Components

- `extensions/delivery-workflow.ts` — `/delivery` and nine bounded public tools.
- `extensions/delivery-workflow-core.mjs` — attached execution, status, reconcile, continuation, disposition, cleanup, and stop.
- `extensions/lib/scheduler.mjs` — strict contracts, readiness, previews, context packets, reconciliation analysis, and metrics.
- `extensions/lib/worktree-root.mjs` — standard-library canonical path, repository identity, private derived-root, and explicit-override resolution.
- `extensions/lib/herdr.mjs` — argv-only Herdr `0.9.5`/protocol `22` adapter.
- `extensions/reviewer-result-tool.ts` — nonce-bound implementation/review result writer.

## Execution

1. Verify clean parent checkout, exact base SHA, paths, ownership, and graph. Resolve omitted root to canonical `~/.pi/delivery-worktrees/v1/<repo-slug>-<repo-id>` or validate explicit override; persist canonical root and provenance before launch.
2. Create visible worktree/pane from persisted root evidence and start exact approved model/tools.
3. Wait in slices no longer than 300 seconds until settlement or ticket deadline.
4. Reconcile wait errors with live agent state. Known-active state may wait again while deadline remains; unknown state blocks.
5. Read nonce-bound result. For implementation, run validation with its own timeout.
6. On validation failure only, use at most approved `maxFixRounds` (`0..1`) with same agent/pane/worktree and fresh nonce/result/log.
7. Check Git ownership, persist binary-capable patch/digest and handoff, then mark `validation_passed`.
8. Persist each settlement, refill free slots, and stop new launch after first non-success while active tickets drain.
9. At `delivery_continue`, prove exact integration at clean HEAD and run optional bounded integration validation before downstream launch.
10. For review, snapshot review and parent Git state before/after, record structured verdict, and wait for parent disposition.
11. At explicit cleanup, recheck evidence/live identity and remove only eligible inactive worktrees.

## State and observability

`run.json` and `status.json` are inspection records, not transactional journal. Status distinguishes pending, running, validation-passed, integrated, cleaned, blocked, failed, stopped, timed-out, reviewed, and disposed work. Current runtime persists ticket deadline expiry as blocked; timed-out is recognized persisted or external lifecycle evidence, not a state current deadline handling creates. Status also reports retained resources, verdict counts, exact next action, and metrics.

Metrics contain wall time, worker time, utilization, weighted critical path, validation/fix/block/review/cleanup counts, missing timing, and incomplete flags. Missing evidence yields `null` and flags, not zero.

`delivery_reconcile` observes persisted records, Herdr workspace state, evidence, and Git. It returns contradictions and non-mutating recommendations. It never infers success, writes status, resumes, replays, stops, replaces, integrates, or cleans.

Best-effort desktop notification occurs only after failure/block persistence. Notification failure is recorded without replacing root outcome. Launch does not focus panes.

## Authority and limits

Parent owns product/architecture decisions, approvals, finding disposition, integration, explicit cleanup, acceptance, and publication. Package never merges, applies patches, deletes branches/evidence, changes provider/model, installs dependencies, or publishes.

Worktrees isolate writers, not user OS. Read-only review tools narrow capability; Git snapshots detect mutation but are not sandboxing.

Derived repository identity is full SHA-256 of `pi-delivery-worktree-root:v1\0` plus normalized canonical repository top-level path. Derived package-owned directories request private mode and reject symlinks, wrong ownership, or group/other write access where POSIX semantics apply. No temp fallback or root pruning exists. Explicit roots remain operator-owned and unchanged.

Herdr accepts string paths, so local-user rename/symlink races cannot be eliminated. Runtime rechecks immediately before creation, verifies canonical returned path and Git identity immediately after, and retains any contradictory resource for inspection. Later status, reconciliation, continuation, disposition, and cleanup use persisted root/path evidence; they never rederive it.
