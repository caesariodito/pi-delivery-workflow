# Safety and recovery

## Trust boundaries

Extension and detached runner execute with user OS permissions. Install trusted revisions only. Project files and model output remain untrusted data. Never put credentials, `.env` values, provider tokens, `auth.json`, MCP secrets, raw session transcripts, or unrelated private data in tickets, context, prompts, or fixtures.

## Command and setup policy

Validation is structured `{ executable, args, cwd? }`. Runtime uses `spawn`/`execFile` with `shell: false`. Herdr setup and Pi setup are separate argv entries; worker gets model flag, reviewer gets model, extension path, configured result path, nonce, and tools. No input becomes shell syntax.

Context/review input paths must be bounded regular non-symlink UTF-8 files under repository `.scratch/`. Ticket ownership paths are normalized POSIX paths. Worktree, pane, branch, base SHA, result file, and candidate digest must match approved contract.

## Unattended boundary

Plan approval does not authorize dependency additions, product/architecture choices, broader ownership, public API breaks, risky migrations, credential/permission changes, model changes, alternate execution, publication, deployment, merge, or cleanup. Such changes block and return to parent/user.

## Result and review safety

Worker completion requires exclusive 0600 result file. Reviewers receive only read, grep, find, ls, and `delivery_result_write`. Scoped tool accepts no path, checks configured nonce, exclusively creates configured 0600 file, and binds verdict to frozen candidate hash. Candidate drift during validation/review blocks.

## Failure classes

- `needs_fix`: same retained writer receives accepted findings, up to approved maximum two rounds.
- `blocked`: decision, protocol, identity, provider, Herdr, validation, scope, or fix-limit failure needs parent action.
- validation failure: inspect immutable log; do not claim completion.
- Herdr/model failure: no fallback.
- `stop_unconfirmed`: recorded worker stop not proven; retain worktree and inspect manually.
- `stopped`: recorded worker settled only; reviewer inactivity and cleanup safety remain unproven.
- blocked decision reply: `delivery_reply` is currently unavailable because runtime does not persist `ticket.question`; reserved API rejects normal replies.
- integration verification failure: preserve `awaiting_integration` evidence and correct parent integration.
- deleted path: continuation accepts only path-bound absence sentinel when exact path is absent at integrated commit; mismatches and Git errors block.
- missing/dead detached runner: replacement entry reconciles exact durable ownership and retained Herdr identity before inbox or scheduling; ambiguity blocks without fallback/replacement.
- legacy state: unsupported and read-only.

## Recovery sequence

1. Detached entry checks durable lock and runner evidence before inbox or scheduling.
2. Only proven-stale ownership can be taken over; live or unknown owners are not overwritten.
3. Recovery queries exact retained Herdr target and accepts only settled, schema-valid, candidate-bound result evidence.
4. Exact reviewed completion resumes scheduling; no replacement worker/reviewer or model fallback is launched.
5. Incomplete, ambiguous, unavailable, or non-settled recovery atomically blocks affected lanes and preserves evidence.
6. Inspect blocked agents/worktrees read-only and perform cleanup manually; never hand-edit state to manufacture progress.

## Stop and cleanup

`delivery_stop` queues bounded request. Scheduler interrupts only exact recorded worker and waits for that worker to report `done`, `blocked`, or `idle`. Failure to prove worker state records `stop_unconfirmed`. `stopped` does not prove reviewer targets or panes inactive. Stop never removes worktree or runtime evidence.

Manual cleanup requires: manually verified inactivity of recorded worker and every reviewer target and pane, inspected ownership evidence, clean worktree state, accepted or abandoned handoff, and operator-chosen Herdr worktree removal. Preserve and reconcile dirty worktrees; never discard them based on `stopped`. Remove runtime directory only after recovery/audit need ends. No cleanup is automatic.

## Legacy upgrade

Runs from legacy pi-subagents installs cannot be controlled or continued. Preserve legacy directories, settle old agents using old installation, remove old dependency, reinstall current package, verify exact Herdr compatibility, reload Pi, and start fresh run. Never rename legacy state into `.scratch/delivery/`.

## Live validation

Mock tests cover command construction and protocols, not real terminal/server behavior. Before publication, run disposable live fixture described in `CONTRIBUTING.md`, redact evidence, and obtain separate release authority. Package itself performs no publication.
