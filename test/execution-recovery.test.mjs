import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { contract } from "./fixtures/execution-contract.mjs";
import { executionContractDigest } from "../extensions/lib/execution-contract.mjs";
import { openExecutionStore } from "../extensions/lib/execution-store.mjs";
import { inspectExecutionRecovery, verifyExecutionActorIdentity } from "../extensions/lib/execution-recovery.mjs";
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "execution-recovery-"))); fs.chmodSync(root, 0o700); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const c = contract(); const digest = executionContractDigest(c); const now = Date.parse("2026-10-29T01:00:00.000Z"); const store = openExecutionStore(root);
  const state = { contractDigest: digest, phase: "stopped", candidateCommit: c.baseSha, operationCount: 1, evidence: ["operation-1"], budget: { contractDigest: digest, startedAt: now - 1000, deadlineAt: now - 1000 + 14400 * 1000, actorLaunches: 0, remediationRounds: 0, noProgressAttempts: 0 } };
  store.acquire(); store.begin("operation-1", { kind: "verify", contractDigest: digest, candidateCommit: c.baseSha, deadlineAt: state.budget.deadlineAt }); store.settle("operation-1", { verified: true }); store.saveState(state); store.release();
  const args = { contract: c, approval: { contractDigest: digest, approvedBy: "operator", approvedAt: "2026-10-29T00:00:00.000Z" }, store, observations: { verified: true, repositoryPath: c.repositoryPath, parentHead: c.baseSha, parentClean: true, candidateCommit: c.baseSha, candidateClean: true, contextUnchanged: true, writerInactive: true }, now };
  return { root, store, state, args };
}
function update(store, state) { store.acquire(); store.saveState(state); store.release(); }

test("verified checkpoint audit is read-only and never itself authorizes resume", t => {
  const { root, args } = fixture(t); const before = fs.readdirSync(root).map(name => [name, fs.readFileSync(path.join(root, name), "utf8")]);
  const result = inspectExecutionRecovery(args); assert.equal(result.status, "checkpoint_verified"); assert.equal(result.resumeAllowed, false); assert.equal(result.replayAllowed, false);
  assert.deepEqual(fs.readdirSync(root).map(name => [name, fs.readFileSync(path.join(root, name), "utf8")]), before);
});

test("missing outcome, retained controller and snapshot gap block recovery", t => {
  const { root, store, args } = fixture(t);
  store.acquire(); assert.match(inspectExecutionRecovery(args).issues.join(" "), /lock retained/); store.release();
  fs.unlinkSync(path.join(root, "operation-1.outcome.json")); assert.equal(inspectExecutionRecovery(args).status, "recovery_unknown");
  store.acquire(); store.begin("operation-2", { kind: "launch" }); store.release(); assert.match(inspectExecutionRecovery(args).issues.join(" "), /inventory/);
});

test("live Git/context drift and active writer block checkpoint acceptance", t => {
  const { args } = fixture(t);
  for (const [key, value] of [["parentHead", "b".repeat(40)], ["candidateClean", false], ["writerInactive", false], ["contextUnchanged", false], ["verified", false]]) assert.equal(inspectExecutionRecovery({ ...args, observations: { ...args.observations, [key]: value } }).status, "recovery_unknown", key);
});

test("deadline and budget identity survive inspection without reset", t => {
  const { args, store, state } = fixture(t);
  const expired = inspectExecutionRecovery({ ...args, now: state.budget.deadlineAt }); assert.equal(expired.status, "blocked");
  state.budget.contractDigest = "c".repeat(64); update(store, state); assert.equal(inspectExecutionRecovery(args).status, "recovery_unknown");
});

test("completed outcome stays terminal rather than becoming resumable", t => {
  const { args, store, state } = fixture(t); state.phase = "completed"; update(store, state);
  assert.equal(inspectExecutionRecovery(args).status, "completed");
});

test("actor reattachment rejects reused name, changed process or uncertain state", () => {
  const expected = { agentId: "agent-id", name: "worker", workspace: "w1", pane: "p1", worktreePath: "/worktree", repositoryPath: "/repo", model: "model", startedAt: "timestamp", attemptId: "attempt-1", nonce: "nonce-1" };
  const live = { ...expected, status: "working" }; assert.equal(verifyExecutionActorIdentity(expected, live), true);
  for (const key of Object.keys(expected)) assert.equal(verifyExecutionActorIdentity(expected, { ...live, [key]: "changed" }), false, key);
  assert.equal(verifyExecutionActorIdentity(expected, { ...live, status: "unknown" }), false);
});


test("settled pending operation and over-budget state cannot silently become resumable", t => {
  const { args, store, state } = fixture(t); state.pendingOperation = "operation-1"; update(store, state);
  assert.match(inspectExecutionRecovery(args).issues.join(" "), /Pending operation/);
  delete state.pendingOperation; state.budget.actorLaunches = 100; update(store, state);
  assert.match(inspectExecutionRecovery(args).issues.join(" "), /counters exceed/);
});
