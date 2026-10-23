# Contributing

## Setup

```bash
npm install
npm run check
npm pack --dry-run
```

Runtime integration additionally requires Git, `herdr 0.9.5` protocol `22`, running Herdr server, Pi, and configured worker/reviewer model IDs. Unit and smoke tests mock Herdr and make no model calls.

## Design rules

- Public Pi extension APIs and Herdr CLI only.
- Parent owns decisions, integration, acceptance, and publication.
- One writer per checkout/worktree.
- Fresh read-only reviewers use scoped nonce-bound result tool.
- Bounded children and at most two fix rounds.
- Executable and argv stay separate; never evaluate workflow input as shell.
- Provider, Herdr, worktree, identity, validation, and recovery ambiguity fail closed.
- Small tasks stay direct.

## Files

- `extensions/delivery-workflow.ts` — `/delivery`, tools, JSON command wrappers.
- `extensions/delivery-workflow-core.mjs` — detached runner launch and control surface.
- `extensions/delivery-runner.mjs` — packed runner exports.
- `extensions/reviewer-result-tool.ts` — scoped review-result writer.
- `extensions/lib/` — Herdr adapter, contracts, runner, scheduler, state, Git evidence.
- `skills/delivery-workflow/SKILL.md` — parent execution policy.
- `test/*.test.mjs` — focused Node tests, including package contents.
- `test/smoke.mjs` — separate no-model smoke check.

## Test expectations

Every behavior change needs focused assertion. `npm test` runs all `test/*.test.mjs` once, then smoke once. `npm run check` adds TypeScript checking.

Before review:

```bash
npm run check
npm pack --dry-run
node --test test/package.test.mjs
git diff --check
```

Package test verifies packed runner, scoped reviewer extension, runtime modules, and skill; it also rejects legacy runtime imports/dependency entries.

## Manual live fixture

No live Herdr runs belong in automated tests. Before any release, use disposable repository and exact supported Herdr version:

1. record `herdr --version` and redacted `herdr status --json`;
2. reload local package in disposable Pi profile;
3. run one approved single-ticket fixture through `delivery_start`;
4. capture worker result pointer, passing validation log, frozen candidate, scoped reviewer result, and handoff manifest;
5. integrate candidate, call `delivery_continue`, and confirm final state;
6. run separate stop fixture and verify `stopped` or document `stop_unconfirmed` handling;
7. confirm retained worktree inspection and manual cleanup;
8. redact repository paths, prompts, tokens, sessions, and credentials before storing evidence.

Synthetic tests do not authorize publication. They cover internal exact-settled recovery seams, not automatic detached-runner restart/reconciliation. Current integration continuation also does not support deleted paths. Merge, tag, push, package publication, deployment, and release each need separate authority.

## Release and upgrade checks

Legacy pi-subagents state has no migration path. Verify old agents are stopped using old installation, preserve needed evidence, remove old dependency, install this package, validate Herdr compatibility, reload Pi, and start new run. Do not reuse legacy run directories.

Use Conventional Commits. Publication stays out of this workflow.
