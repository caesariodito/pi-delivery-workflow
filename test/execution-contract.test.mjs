import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateExecutionContract, executionContractDigest, verifyExecutionApproval, verifyExecutionContext, admitExecutionOperation } from "../extensions/lib/execution-contract.mjs";

import { contract } from "./fixtures/execution-contract.mjs";

test("contract digest ignores key ordering but binds every authority field and exact context hash", () => {
  const c = contract(); const digest = executionContractDigest(c);
  assert.equal(digest, executionContractDigest(Object.fromEntries(Object.entries(c).reverse())));
  for (const mutate of [v => { v.objective += "!"; }, v => { v.actors.writer.model = "other"; }, v => { v.validation[0].args.push("--changed"); }, v => { v.context[0].sha256 = "b".repeat(64); }, v => { v.limits.maxActorLaunches++; }]) {
    const changed = structuredClone(c); mutate(changed); assert.notEqual(executionContractDigest(changed), digest);
  }
  assert.deepEqual(validateExecutionContract(c), c);
});

test("contract fails closed for missing limits, unknown fields, scope escapes and weak reviewer policy", () => {
  const mutations = [v => { delete v.limits.maxActorLaunches; }, v => { v.extra = true; }, v => { v.permissions.parentWrites = true; }, v => { v.permissions.publication = true; }, v => { v.actors.reviewer.tools.push("bash"); }, v => { v.actors.writer.thinking = "high"; }, v => { v.actors.reviewer.model = v.actors.writer.model; }, v => { v.reviewPolicy.unresolvedFindingsBlock = false; }, v => { v.steps[0].ownedPaths = ["../outside"]; }, v => { v.steps[0].ownedPaths = [".git/config"]; }, v => { v.steps[0].ownedPaths = [".scratch/"]; }, v => { v.steps[0].ownedPaths = ["plan.md"]; }, v => { v.steps[0].dependsOn = ["S1"]; }, v => { v.validation[0].criteria = ["missing"]; }, v => { v.criteria.push({ id: "A2", condition: "Uncovered" }); }];
  for (const mutate of mutations) { const c = contract(); mutate(c); assert.throws(() => validateExecutionContract(c)); }
});

test("approval rejects modified contract, invalid time and unknown approval fields", () => {
  const c = contract(); const approvedAt = "2026-10-29T00:00:00.000Z"; const approval = { contractDigest: executionContractDigest(c), approvedBy: "operator", approvedAt }; const now = Date.parse(approvedAt);
  assert.equal(verifyExecutionApproval(c, approval, now), true);
  assert.throws(() => verifyExecutionApproval(c, { ...approval, approvedAt: "2026-02-30T00:00:00.000Z" }, now), /timestamp/);
  assert.throws(() => verifyExecutionApproval(c, approval, now - 1), /timestamp/);
  assert.throws(() => verifyExecutionApproval(c, { ...approval, trusted: true }, now), /fields/);
  c.limits.maxActorLaunches++; assert.throws(() => verifyExecutionApproval(c, approval, now), /digest/);
});

test("context verifies approved bytes and rejects symlinks, hard links and changed files", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "execution-context-")));
  try {
    fs.writeFileSync(path.join(root, "plan.md"), "approved\n"); const c = contract(root); assert.equal(verifyExecutionContext(c), true);
    fs.writeFileSync(path.join(root, "plan.md"), "changed\n"); assert.throws(() => verifyExecutionContext(c), /bytes changed/);
    fs.unlinkSync(path.join(root, "plan.md")); fs.writeFileSync(path.join(root, "other.md"), "approved\n"); fs.symlinkSync("other.md", path.join(root, "plan.md")); assert.throws(() => verifyExecutionContext(c), /symlink/);
    fs.unlinkSync(path.join(root, "plan.md")); fs.linkSync(path.join(root, "other.md"), path.join(root, "plan.md")); assert.throws(() => verifyExecutionContext(c), /hard links/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("operation admission preserves hard deadline and total budgets across restart", () => {
  const c = contract(); const state = { contractDigest: executionContractDigest(c), startedAt: 1000, deadlineAt: 1000 + c.limits.wallTimeSeconds * 1000, actorLaunches: 0, remediationRounds: 0, noProgressAttempts: 0 };
  assert.equal(admitExecutionOperation(c, state, "launch", 2000).remainingMs, state.deadlineAt - 2000);
  assert.throws(() => admitExecutionOperation(c, state, "validate", state.deadlineAt), /deadline exhausted/);
  assert.throws(() => admitExecutionOperation(c, { ...state, deadlineAt: state.deadlineAt + 1 }, "launch", 2000), /deadline drift/);
  assert.throws(() => admitExecutionOperation(c, { ...state, actorLaunches: 8 }, "review", 2000), /launch budget/);
  assert.throws(() => admitExecutionOperation(c, { ...state, remediationRounds: 3 }, "repair", 2000), /remediation budget/);
  assert.throws(() => admitExecutionOperation(c, { ...state, noProgressAttempts: 2 }, "repair", 2000), /no-progress budget/);
});
