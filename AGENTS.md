# Repository guidance

## Scope

Pi package providing `/delivery`, thin supervised Herdr ticket orchestration, and `delivery-workflow` skill.

## Commands

```bash
npm install
npm run check
npm pack --dry-run
```

## Invariants

- Parent retains decisions, integration, cleanup, final acceptance, and publication authority.
- Herdr owns visible worktrees, panes, and agent processes.
- Package stays attached and persists inspection evidence only; no daemon or transparent crash recovery.
- One writer per worktree; ownership cannot overlap.
- Workflow input never becomes shell code.
- Unknown or ambiguous external state blocks without replay or replacement.
- No credentials or session transcripts in tests, docs, fixtures, or artifacts.
- Keep implementation on public Pi and Herdr APIs.

## Changes

Prefer deletion and smallest coherent diff. Add focused test for changed behavior. Use Conventional Commits.
