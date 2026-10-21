# Repository guidance

## Scope

Pi package providing `/delivery`, trusted pi-subagents workflow resources, and delivery-workflow skill.

## Commands

```bash
npm install
npm run check
npm pack --dry-run
```

## Invariants

- Parent retains requirements, decisions, synthesis, final acceptance, and publication authority.
- Small linear tasks remain direct.
- Reviewers use fresh context and stay read-only.
- One writer per checkout/worktree.
- Workflow arguments never become arbitrary shell commands.
- Provider, workflow, and worktree failures fail closed.
- No credentials or session transcripts in tests, docs, fixtures, or artifacts.
- Keep implementation on public Pi and pi-subagents APIs.

## Changes

Use smallest coherent diff. Add focused smoke assertion for changed workflow behavior. Use Conventional Commits.
