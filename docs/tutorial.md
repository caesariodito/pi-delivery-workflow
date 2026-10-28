# Tutorial

## 1. Prepare and preview

Use clean Git checkout, ignored `.scratch/`, Herdr `0.9.5` protocol `22`, `HERDR_ENV=1`, and approved models. Omit `worktreeRoot` for private persistent `~/.pi/delivery-worktrees/v1/<repo-slug>-<repo-id>`, or pass an existing normalized absolute writable real directory outside repository. No temp fallback exists; `.scratch/` stores evidence only.

```text
/delivery Add project API-key rotation
```

Create reviewed spec/plan/context and bounded graph. Keep small work direct. Obtain explicit implementation approval after:

```text
/delivery_preview {"runId":"key-rotation","objective":"Add project API-key rotation","baseSha":"0123456789012345678901234567890123456789","contextPaths":[".scratch/key-rotation/spec.md"],"maxConcurrency":2,"tickets":[...]}
```

## 2. Start and inspect

Call `delivery_start` with same approved run and optional explicit `worktreeRoot`. Runtime persists canonical resolved root plus `derived` or `override` provenance before launch; later operations reuse it rather than current home/environment state. Ready independent tickets run concurrently; free slots refill after settlement.

```text
/delivery_status {"runId":"key-rotation"}
/delivery_steer {"runId":"key-rotation","ticketId":"T001","message":"Keep API shape from SEC-2."}
```

Inspect live Herdr pane/worktree and `.scratch/delivery/key-rotation/` evidence. Status includes lifecycle, review verdicts, retained resources, metrics, incomplete flags, and next action.

## 3. Handle timeout or interruption

Do not reload, replay, or replace ambiguous work. Inspect Herdr and evidence. Use:

```text
/delivery_reconcile {"runId":"key-rotation"}
```

Reconcile is read-only. Contradictions require inspection/retention. Ticket deadline retains workspace; validation timeout may use only approved one-round same-agent repair.

## 4. Integrate

Parent manually integrates accepted exact patches into clean checkout, runs checks, and commits. Then:

```text
/delivery_continue {"runId":"key-rotation","integratedSha":"<current-head>"}
```

Runtime verifies exact patch and optional integration validation before downstream launch. Text-only dependents may use `requiresIntegratedBase: false`.

## 5. Review and dispose

Review ticket has empty ownership, explicit read paths, `read` only, and parent-run checks. Inspect structured verdict/findings and Git snapshots. Record parent decision:

```text
/delivery_dispose {"runId":"key-rotation","ticketId":"R001","disposition":"approve"}
```

Use `changes_requested` or `blocked` when warranted. No automatic acceptance or fix occurs.

## 6. Finish and publish separately

After acceptance, inspect status and explicitly clean eligible worktrees:

```text
/delivery_cleanup {"runId":"key-rotation"}
```

Cleanup preserves branches, `.scratch/` evidence, derived root, and root parents. Run `npm run check` and `npm pack --dry-run` where applicable. Merge, push, tag, publish, deploy, and release remain separate parent-authorized actions outside Delivery.
