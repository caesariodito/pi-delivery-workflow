# Workflow tutorial

## 1. Prepare repository and Herdr

Require clean Git checkout and ignored scratch path:

```bash
herdr --version
herdr status --json
grep -qxF '.scratch/' .gitignore || printf '\n.scratch/\n' >> .gitignore
```

Supported runtime is Herdr `0.9.5`, protocol `22`. Package does not install/start server.

## 2. Start discovery

```text
/delivery Add project-level API key rotation
```

Parent keeps trivial work direct. For workflow candidate, capture requirements, compatibility, trust boundaries, non-goals, and measurable acceptance criteria.

If finalized `implementation-review` artifacts exist under same `.scratch/<task>/`, validate source JSON, require rebuilt review pages, and ensure no unresolved implementation-blocking questions. Treat JSON as source; HTML/exported answers are transport. Compose `spec.md` from `implementation-plan.json` problem/goals/scope/non-goals/acceptance, enriched by `technical-spec.json` behavior/contracts/data/architecture/security/failure handling/verification. Preserve stable IDs and ask only missing/conflicting decisions.

## 3. Review spec and plan

Create:

```text
.scratch/<task>/spec.md
.scratch/<task>/plan.md
.scratch/<task>/context.md
```

Call `delivery_review` for spec then plan:

```json
{
  "runId": "key-rotation-spec",
  "kind": "spec",
  "artifact": ".scratch/key-rotation/spec.md",
  "contextBundle": ".scratch/key-rotation/context.md"
}
```

Reviewer is fresh, read-only, fixed model, and writes nonce-bound result through scoped tool. Parent classifies findings as valid, stale, invalid, speculative, or blocked, revises accepted items, and returns product/architecture decisions to user.

Plan should use `implementation-plan.json` delivery choices when present: business context, seams, contracts/files, ordering, ownership, dependencies, validation, rollout, done, tickets. `technical-spec.json` owns technical contracts; `implementation-plan.json` owns delivery decisions.

## 4. Freeze context and tickets

After artifacts stabilize, freeze context with objective, artifact digests, repository/base, decisions, constraints, validation, and escalation. Create bounded tickets with exact owned/forbidden paths, dependencies/batches, validation, acceptance, Herdr worktree/pane identities, and max two fix rounds. Independent writers require separate worktrees and non-overlapping ownership.

## 5. Approve

Present reviewed paths, tickets/batches, ownership, exact executable/argv gates, worker/reviewer models, Herdr identities, fix ceiling, expected cost/latency, and blocking conditions. Obtain one explicit plan-wide implementation approval. Approval excludes scope/model/dependency/API/migration/publication/integration-mode changes.

## 6. Start approved run

Call `delivery_start` with approved base SHA, serialized ticket array, and validation argv. See [ticket contract](ticket-contract.md). Runner validates all contracts before claiming run directory, then detaches.

Herdr creates approved worktree, starts Pi worker with model argv, waits for exclusive worker result, runs gate, freezes candidate, and starts fresh reviewer with:

```text
--model <reviewer-model>
--extension <packed reviewer-result-tool.ts>
--delivery-result-path <absolute result path>
--delivery-result-nonce <nonce>
--tools read,grep,find,ls,delivery_result_write
```

These are discrete argv, not shell string.

## 7. Supervise

```text
/delivery_status {"runId":"key-rotation"}
/delivery_steer {"runId":"key-rotation","ticketId":"T001","message":"Use approved contract section SEC-2."}
/delivery_stop {"runId":"key-rotation","ticketId":"T001"}
```

Use steer for bounded guidance. `delivery_reply` is reserved but currently rejects normal blocked decisions because runtime does not persist `ticket.question`; do not use it as workflow instruction. Stop targets recorded worker only; `stopped` does not prove reviewer inactivity, and `stop_unconfirmed` means retain everything and inspect.

## 8. Integrate and continue

At `awaiting_integration`, parent inspects result files, validation, review, patch, path hashes, and handoff. If any changed path is deleted, do not integrate or continue: current verifier expects content for every path and rejects deletions. Preserve evidence and escalate; deletion support is pending. Otherwise integrate reviewed `done` lanes, commit clean parent checkout, then:

```text
/delivery_continue {"runId":"key-rotation","integratedSha":"<40-or-64-hex-sha>"}
```

Runtime verifies clean checkout, ancestry, exact integrated path hashes, and validation before dependent batch. Repeat until final state, then parent performs final acceptance. Merge, push, deploy, release, and publication remain separately authorized.

## 9. Recover and clean up

After interruption, establish detached runner still exists. No automatic restart/reconciliation is wired. Missing/dead runner can leave active state and unconsumed inbox; treat it as blocked, send no controls, do not integrate, preserve every artifact/worktree/agent identity, and escalate without fallback or replacement. Exact-settled recovery is only an internal unit-tested seam, not an operator feature.

After acceptance or abandonment, manually verify recorded worker and every reviewer target and pane inactive, inspect ownership evidence, and require clean worktree state before removing worktrees and later runtime evidence. Preserve and reconcile dirty changes. No automatic cleanup.

Legacy pi-subagents runs cannot continue. Settle them with old install, preserve evidence, remove old dependency, install current package, verify Herdr, reload, and start new run.

## 10. Manual live fixture

Automated tests are synthetic. Before release, follow `CONTRIBUTING.md` disposable live fixture and retain redacted evidence for status handshake, worker result, scoped reviewer result, integration continuation, stop, and cleanup. Do not publish without separate authority.
