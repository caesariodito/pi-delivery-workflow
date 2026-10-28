# Safety and recovery

## Safety model

- Worktrees separate concurrent writers; they are not security sandboxes.
- Implementation ownership is exact and non-overlapping. Review uses empty ownership, explicit read paths, and `read` tool only.
- Commands use executable plus argv with `shell: false`.
- Models/tools are explicit; no fallback.
- Git evidence determines changes. Binary patch and SHA-256 digest precede `validation_passed`.
- Exact reverse application at clean parent HEAD proves integration; ancestry alone does not.
- Unknown Herdr state, missing result, deadline, ownership violation, failed validation, review mutation, or evidence mismatch blocks.
- Parent owns finding disposition, integration, cleanup, publication, and destructive actions.
- Omitted roots derive under canonical user profile at `~/.pi/delivery-worktrees/v1`; identity hashes normalized canonical repository path. Package-owned directories must remain private where POSIX ownership/mode checks apply. No temp fallback exists.
- Explicit roots must already be normalized absolute writable real directories outside repository; package does not create or chmod them.
- Resolved canonical root and provenance persist before launch. Later operations reuse persisted root/path evidence and never rederive it from current home, environment, or moved repository.

## Interruption and recovery boundary

No daemon or transparent crash recovery exists. Package persists evidence and leaves Herdr resources visible.

After Pi/workflow exit:

1. Inspect live Herdr agent/pane/worktree.
2. Inspect `.scratch/delivery/<run>/` records and Git state.
3. Call read-only `delivery_reconcile` if runtime is available.
4. Preserve dirty or ambiguous worktree; do not infer success from live `done` state.
5. Resolve ownership and evidence manually before starting a new supervised run.

Reconcile only observes and recommends. It never repairs records, resumes, replays, interrupts, replaces, integrates, or cleans.

## Timeout and repair

Ticket deadlines use repeated wait slices no longer than 300 seconds. Known active state can continue waiting until deadline; unknown state blocks. Deadline expiry retains resources without automatic interrupt or replacement.

Validation has separate bounded timeout. One explicitly approved repair round may reuse same agent/worktree after validation failure, with fresh immutable prompt/result/log evidence and unchanged scope. No repair occurs for unknown state, blocked result, ticket timeout, or exhausted limit.

## Review safety

Review worker receives `read` only plus scoped result writer. Runtime snapshots review worktree and parent checkout before/after. This detects mutation; it does not prevent OS access. Mutation or unverifiable snapshots block. Verdict never equals parent acceptance; `delivery_dispose` records explicit parent decision.

## Retention and notification

Validation-passed, reviewed, blocked, failed, stopped, timed-out, running, unknown, mismatched, and legacy work retains resources. Best-effort notification follows persisted failure/block state; notification failure cannot replace root outcome.

Explicit cleanup removes only evidence-backed integrated implementation work or approved disposed review work with inactive matching identity. Branches, runtime evidence, derived roots, and root parents remain; package never prunes roots. Package performs no reset, stash, branch deletion, automatic cleanup, pane-only close, merge, patch application, push, publish, deploy, or release.

String-path Herdr calls leave a local-user rename/symlink TOCTOU ceiling. Runtime rechecks root immediately before creation and canonical path/Git identity immediately after. Any root, expected, returned, live, or persisted-path contradiction blocks and retains possibly created resources; it never deletes, replaces, or replays them.

Cleanup retry is safe only after recorded pre-removal failure. Removal success followed by state-write failure is ambiguous; inspect Herdr and evidence, then stop rather than replay.
