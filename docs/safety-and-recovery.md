# Safety and interruption

## Safety model

- Worktrees separate concurrent writers; they are not security sandboxes.
- Ticket ownership is exact file or directory-prefix scope and cannot overlap.
- Commands use executable plus argv with `shell: false`.
- Models and tools are explicit; no fallback.
- Actual changes come from Git evidence.
- Unknown Herdr state, missing result, ownership violation, or failed validation blocks.
- Parent owns integration, cleanup, publication, and destructive actions.

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

Done, blocked, failed, and stopped tickets keep worktrees and panes. Cleanup requires explicit operator action after inspection. Package performs no reset, stash, branch deletion, worktree removal, pane close, merge, push, publish, deploy, or release.
