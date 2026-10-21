# Contributing

## Setup

```bash
npm install
npm run check
```

## Design rules

- Native Pi and pi-subagents first.
- Parent owns decisions and acceptance.
- One writer per checkout/worktree.
- Fresh, read-only reviewers.
- Bounded children and fix loops.
- No service, database, polling loop, or freeform agent chatter.
- No arbitrary shell command from resource arguments.
- Small tasks stay direct.

## Files

- `extensions/delivery-workflow.ts` — command and resource registration.
- `extensions/delivery-workflow-core.mjs` — pure argument validation and workflow generation.
- `skills/delivery-workflow/SKILL.md` — parent execution policy.
- `test/smoke.mjs` — no-model runnable self-check.

## Test expectations

Every behavior change needs focused assertion. At minimum test:

- model routing;
- fresh review context;
- generated workflow static validity;
- state transitions;
- retained writer fix path;
- command-injection rejection;
- fix-round ceiling.

For installed integration, validate generated scripts with:

```text
subagent({ action: "validate", workflow: "./path/to/generated.js" })
```

Do not run real mutation lanes against production repository for smoke testing.

## Release

Use Conventional Commits. Before release:

1. run `npm run check`;
2. install package from local path in disposable Pi profile or trusted test session;
3. run `/subagents-doctor`;
4. confirm `/delivery` command and `delivery-workflow` skill load;
5. validate named resources;
6. inspect packed files with `npm pack --dry-run`;
7. tag version.
