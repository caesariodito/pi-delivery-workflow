# Safety and interruption

## Safety model

- Worktrees separate concurrent writers; they are not security sandboxes.
- Ticket ownership is exact file or directory-prefix scope and cannot overlap.
- Commands use executable plus argv with `shell: false`.
- Models and tools are explicit; no fallback.
- Actual changes come from Git evidence; successful validation persists a binary patch and SHA-256 digest.
- Exact reverse application at clean parent HEAD proves per-ticket integration; ancestry alone does not.
- Unknown Herdr state, missing result, ownership violation, failed validation, or evidence mismatch blocks.
- Parent owns integration, explicit cleanup invocation, publication, and other destructive actions.

## Interruption model

No automatic crash recovery exists.

If Pi or attached workflow exits:

1. inspect agent, pane, and worktree in Herdr;
2. inspect `.scratch/delivery/<run>/status.json`, prompt, result, log, and handoff;
3. never replay ambiguous prompt or action;
4. preserve dirty worktree;
5. start a new supervised run only after operator decides ownership is clear.

`delivery_status` reads inspection state. It does not prove process liveness. `delivery_steer` works only for active run in same Pi process. `delivery_stop` sends interrupt; operator verifies settlement.

## Retention

`validation_passed`, blocked, failed, stopped, active, unknown, and legacy tickets keep worktrees and panes. Explicit `delivery_cleanup` removes only exact integrated, inactive, identity-matched Herdr worktrees and records `cleaned`; it preserves branches and all runtime evidence. Package performs no reset, stash, branch deletion, automatic cleanup, pane-only close, merge, patch application, push, publish, deploy, or release.

Cleanup retries are safe only after a recorded pre-removal failure. A removal-success/state-write-failure is ambiguous: inspect live Herdr state and preserved patch/integration evidence manually. Do not replay.
