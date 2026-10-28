# Contributing

```bash
npm install
npm run check
npm pack --dry-run
```

## Design rules

- Thin attached wrapper; Herdr owns visible worktrees, panes, and agents.
- Parent owns decisions, review disposition, integration, cleanup, final acceptance, and publication.
- One writer per worktree; ownership does not overlap.
- Commands use executable and argv with `shell: false`.
- Unknown or contradictory external state blocks without replay/replacement.
- Persist inspection evidence, not recovery framework.
- Read-only reconcile observes persisted state, Herdr, evidence, and Git; it never repairs state.
- Metrics expose missing timing with incomplete flags, never guessed zeroes.
- Prefer deletion over new orchestration machinery.

## Files

- `extensions/delivery-workflow.ts` — `/delivery` and bounded public tools.
- `extensions/delivery-workflow-core.mjs` — attached orchestration.
- `extensions/lib/herdr.mjs` — Herdr adapter.
- `extensions/lib/scheduler.mjs` — contracts, graph, reconcile analysis, and metrics.
- `extensions/reviewer-result-tool.ts` — scoped implementation/review result writer.
- `test/*.test.mjs` — focused synthetic tests.

New dependency-free worker tests import only `node:` modules and `.mjs` project files. Tests needing TypeScript packages belong in parent `npm run check`, not fresh no-install worktrees.

## Live fixture

Before release, use disposable repository and exact supported Herdr version:

1. Run two independent tickets with concurrency 2; confirm visible worktrees/panes, distinct packets, immediate slot refill, and retained evidence.
2. Confirm bounded result collection, validation, one approved repair round, timeout retention, and dependency handoff.
3. Manually integrate exact patches; confirm optional integration validation and downstream launch.
4. Run read-only review, record explicit disposition, then exercise read-only reconcile.
5. Confirm failure, unknown state, and notification failure preserve root outcome/resources.
6. Inspect metrics and incomplete-data flags; invoke cleanup only after acceptance.

Automated fixtures do not authorize publication. Merge, push, tag, package publication, deploy, and release require separate authority. Use Conventional Commits.
