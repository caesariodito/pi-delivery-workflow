# Contributing

```bash
npm install
npm run check
npm pack --dry-run
```

## Design rules

- Thin attached wrapper; Herdr owns visible worktrees, panes, and agents.
- Parent owns decisions, integration, cleanup, and publication.
- One writer per worktree; ownership does not overlap.
- Commands use executable and argv with `shell: false`.
- Unknown or ambiguous external state blocks without replay/replacement.
- Persist inspection evidence, not recovery framework.
- Prefer deletion over new orchestration machinery.

## Files

- `extensions/delivery-workflow.ts` — `/delivery` and bounded tool surface.
- `extensions/delivery-workflow-core.mjs` — attached orchestration.
- `extensions/lib/herdr.mjs` — Herdr adapter.
- `extensions/lib/scheduler.mjs` — graph validation and context packets.
- `extensions/reviewer-result-tool.ts` — scoped ticket-result writer.
- `test/*.test.mjs` — focused synthetic tests.

## Live fixture

Before release, use disposable repository and exact supported Herdr version:

1. run two independent tickets with concurrency 2;
2. confirm two visible worktrees/panes and distinct context packets;
3. confirm result files, validation, and handoffs;
4. integrate one batch manually and continue dependent ticket;
5. confirm validation failure and unknown state preserve resources;
6. retain redacted evidence; do not clean automatically.

Automated fixtures do not authorize publication. Merge, push, tag, package publication, deploy, and release require separate authority.

Use Conventional Commits.
