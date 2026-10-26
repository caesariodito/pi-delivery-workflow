# Tutorial

## 1. Prepare

Use clean Git checkout, ignored `.scratch/`, Herdr `0.9.5` protocol `22`, and `HERDR_ENV=1`.

## 2. Plan

```text
/delivery Add project API-key rotation
```

Keep small work direct. For workflow work, create reviewed `spec.md`, `plan.md`, `context.md`, and bounded ticket graph. Obtain explicit implementation approval covering models, tools, ownership, validation, concurrency, and stop conditions.

## 3. Start

```json
{
  "runId": "key-rotation",
  "objective": "Add project API-key rotation",
  "baseSha": "0123456789012345678901234567890123456789",
  "worktreeRoot": "/tmp/herdr-key-rotation",
  "contextPaths": [".scratch/key-rotation/spec.md", ".scratch/key-rotation/plan.md"],
  "maxConcurrency": 2,
  "tickets": []
}
```

Use [ticket contract](ticket-contract.md) for ticket objects. `delivery_start` runs attached. Ready independent tickets launch concurrently in visible Herdr worktrees.

## 4. Inspect and supervise

```text
/delivery_status {"runId":"key-rotation"}
/delivery_steer {"runId":"key-rotation","ticketId":"T001","message":"Keep API shape from SEC-2."}
```

Each prompt packet and result lives under `.scratch/delivery/key-rotation/`. Inspect live pane/worktree in Herdr.

## 5. Integrate

Parent manually integrates accepted completed branches. Dependent code tickets wait at `awaiting_integration`. After clean commit:

```text
/delivery_continue {"runId":"key-rotation","integratedSha":"<current-head>"}
```

Text-only dependents may declare `requiresIntegratedBase: false` and consume concise handoffs immediately.

## 6. Handle failure

Blocked, failed, unknown, timeout, or interrupted work remains visible and retained. Do not replay ambiguous prompts. No daemon resumes workflow after Pi exits. Operator inspects and chooses whether to start a new supervised run.

## 7. Finish

Parent performs acceptance and any integration. Cleanup, merge, push, publish, deploy, and release remain separate explicit actions.
