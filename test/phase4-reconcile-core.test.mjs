import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createDeliveryWorkflowCore } from "../extensions/delivery-workflow-core.mjs";

function fixture(status, ticket = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-reconcile-"));
  execFileSync("git", ["init", "-q"], { cwd: root }); execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root }); execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  fs.writeFileSync(path.join(root, ".gitignore"), ".scratch/\n"); fs.writeFileSync(path.join(root, "tracked.txt"), "unchanged\n"); execFileSync("git", ["add", "."], { cwd: root }); execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
  const directory = path.join(root, ".scratch", "delivery", "run-1"); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "status.json"), `${JSON.stringify({ version: 2, runId: "run-1", phase: "blocked", tickets: { T1: { status, ...ticket } } }, null, 2)}\n`);
  return { root, directory };
}
function bytes(root, directory, worktree) { return { head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }), status: execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root }), persisted: fs.readFileSync(path.join(directory, "status.json")), ...(worktree ? { worktreeHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }), worktreeStatus: execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: worktree }) } : {}) }; }

for (const [status, expected] of [["pending", "await_scheduler"], ["running", "observe_only"], ["validation_passed", "verify_patch_then_integrate"], ["integrated", "verify_then_cleanup"], ["cleaned", "retain_or_inspect"], ["blocked", "retain_or_inspect"], ["failed", "retain_or_inspect"], ["stopped", "retain_or_inspect"], ["timed_out", "retain_or_inspect"], ["reviewed", "record_parent_disposition"]]) test(`reconcile observes ${status} without mutation`, async () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-reconcile-tree-")); execFileSync("git", ["init", "-q"], { cwd: worktree }); execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: worktree }); execFileSync("git", ["config", "user.name", "Test"], { cwd: worktree }); fs.writeFileSync(path.join(worktree, "owned.txt"), "unchanged\n"); execFileSync("git", ["add", "."], { cwd: worktree }); execFileSync("git", ["commit", "-qm", "base"], { cwd: worktree });
  const worktreeHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim();
  const ticket = { workspace: "w1", worktreePath: worktree, ...(status === "validation_passed" ? { validation: { passed: true } } : {}), ...(status === "integrated" ? { integrationEvidence: { verifiedAt: "2025-01-01T00:00:00Z", integratedSha: "deadbeef" } } : {}), ...(status === "reviewed" ? { verdict: "approve" } : {}) };
  const run = fixture(status, ticket); const calls = [];
  const herdr = { async workspaceList() { calls.push("workspaceList"); return { workspaces: [{ workspace_id: "w1", agent_status: status === "running" ? "working" : "idle", worktree: { checkout_path: worktree } }] }; }, async worktreeRemove() { assert.fail("mutator called"); }, async agentPrompt() { assert.fail("mutator called"); }, async agentStart() { assert.fail("mutator called"); }, async agentSendKeys() { assert.fail("mutator called"); } };
  const before = bytes(run.root, run.directory, worktree); const output = await createDeliveryWorkflowCore({ herdr }).reconcile(run.root, { runId: "run-1" }); const after = bytes(run.root, run.directory, worktree);
  assert.deepEqual(after, before); assert.deepEqual(calls, ["workspaceList"]); assert.equal(output.details.observations.parentUnchanged, true); assert.equal(output.details.observations.gitTickets.T1.worktreeHead, worktreeHead); assert.equal(output.details.observations.gitTickets.T1.worktreeStatusBytes, 0); assert.equal(output.details.inferredSuccess, false);
  if (["validation_passed", "integrated", "cleaned"].includes(status)) assert.equal(output.details.hasContradictions, true); else assert.equal(output.details.tickets[0].recommendation.action, expected);
});

test("reconcile flows disposed review verdict and unchanged evidence into cleanup analysis", async () => {
  const reviewEvidence = { parentUnchanged: true, worktreeUnchanged: true };
  const approved = fixture("disposed", { disposition: "approve", verdict: "approve", reviewEvidence });
  const herdr = { async workspaceList() { return { workspaces: [] }; } };
  const output = await createDeliveryWorkflowCore({ herdr }).reconcile(approved.root, { runId: "run-1" });
  assert.equal(output.details.hasContradictions, false);
  assert.equal(output.details.tickets[0].recommendation.action, "verify_then_cleanup");

  const adverse = fixture("disposed", { disposition: "approve", verdict: "approve", reviewEvidence: { ...reviewEvidence, parentUnchanged: false } });
  const blocked = await createDeliveryWorkflowCore({ herdr }).reconcile(adverse.root, { runId: "run-1" });
  assert.equal(blocked.isError, true);
  assert.deepEqual(blocked.details.tickets[0].contradictions.map(({ code }) => code), ["disposed_review_parent_unchanged_missing"]);
  assert.equal(blocked.details.tickets[0].recommendation.action, "inspect_and_retain");
});

test("reconcile reports bounded contradictory observations and safe retain action", async () => {
  const run = fixture("running", { workspace: "w1", worktreePath: "/recorded/path" }); const calls = [];
  const herdr = { async workspaceList() { calls.push("workspaceList"); return { workspaces: [{ workspace_id: "w1", agent_status: "done", worktree: { checkout_path: "/other/path" } }] }; }, async worktreeRemove() { assert.fail("mutator called"); } };
  const output = await createDeliveryWorkflowCore({ herdr }).reconcile(run.root, { runId: "run-1" });
  assert.deepEqual(calls, ["workspaceList"]); assert.equal(output.isError, true); assert.equal(output.details.hasContradictions, true); assert.deepEqual(output.details.tickets[0].contradictions.map(({ code }) => code), ["live_done_not_proof", "running_agent_not_active", "workspace_identity_mismatch"]); assert.deepEqual(output.details.safeActions, ["inspect_and_retain"]); assert.equal(output.details.inferredSuccess, false);
});

test("malformed Herdr observation blocks without fallback or mutation", async () => {
  const run = fixture("running"); const before = bytes(run.root, run.directory); const output = await createDeliveryWorkflowCore({ herdr: { async workspaceList() { return {}; } } }).reconcile(run.root, { runId: "run-1" });
  assert.equal(output.isError, true); assert.equal(output.details.status, "blocked"); assert.deepEqual(output.details.safeActions, ["inspect_and_retain"]); assert.deepEqual(bytes(run.root, run.directory), before);
});
