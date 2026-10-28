import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createDeliveryWorkflowCore } from "../extensions/delivery-workflow-core.mjs";

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-review-core-"));
  execFileSync("git", ["init", "-q"], { cwd: root }); execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root }); execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  fs.writeFileSync(path.join(root, ".gitignore"), ".scratch/\n"); fs.writeFileSync(path.join(root, "spec.md"), "spec\n"); execFileSync("git", ["add", "."], { cwd: root }); execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
  return { root, sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), worktreeRoot: fs.mkdtempSync(path.join(os.tmpdir(), "delivery-review-trees-")) };
}

function input(fixture) { return { runId: "review-run", objective: "Review", baseSha: fixture.sha, worktreeRoot: fixture.worktreeRoot, tickets: [{ id: "R1", mode: "review", goal: "Review", definitionOfDone: "Verdict", dependencies: [], ownedPaths: [], readPaths: ["spec.md"], worker: { name: "reviewer", kind: "reviewer", model: "model", thinking: "medium", tools: ["read"] }, validation: { executable: "parent-check-must-not-run", args: [] }, maxFixRounds: 0, specPaths: ["spec.md"] }] }; }

async function scenario(verdict, { mutateWorktree = false, unknownAfter = false } = {}) {
  const fixture = repository(); let worktreePath; let startArgs; let removed = 0;
  const herdr = {
    async status() {}, async integrationStatus() { return [{ name: "pi", status: "current (v1)" }]; },
    async worktreeCreate({ path: createdPath }) { worktreePath = createdPath; execFileSync("git", ["worktree", "add", "--detach", createdPath, fixture.sha], { cwd: fixture.root }); return { path: createdPath, pane: "p1", workspace: "w1" }; },
    async agentStart({ agentArgs }) { startArgs = agentArgs; const resultPath = agentArgs[agentArgs.indexOf("--delivery-result-path") + 1]; fs.mkdirSync(path.dirname(resultPath), { recursive: true }); fs.writeFileSync(resultPath, JSON.stringify({ version: 1, ticketId: "R1", verdict, summary: verdict, findings: verdict === "changes_requested" ? [{ severity: "high", affectedPath: "spec.md", evidence: "problem", disposition: "open" }] : [], residualRisks: [], question: null })); if (mutateWorktree) fs.writeFileSync(path.join(worktreePath, "mutation.txt"), "x"); },
    async agentGet() { if (unknownAfter) { fs.rmSync(worktreePath, { recursive: true, force: true }); unknownAfter = false; } return { agent: { agent_status: "done" } }; },
    async workspaceList() { return { workspaces: [{ workspace_id: "w1", agent_status: "idle", worktree: { checkout_path: worktreePath } }] }; },
    async worktreeRemove() { removed += 1; execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: fixture.root }); return { type: "worktree_removed" }; },
  };
  const previous = process.env.HERDR_ENV; process.env.HERDR_ENV = "1";
  try { const core = createDeliveryWorkflowCore({ herdr }); const started = await core.start(fixture.root, input(fixture)); return { fixture, core, started, startArgs, get removed() { return removed; } }; }
  finally { if (previous === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previous; }
}

for (const verdict of ["approve", "changes_requested", "blocked"]) test(`review records ${verdict} and requires explicit matching-independent parent disposition`, async () => {
  const run = await scenario(verdict); const ticket = run.started.details.tickets.R1;
  assert.equal(run.started.details.phase, "awaiting_disposition"); assert.equal(ticket.status, "reviewed"); assert.equal(ticket.verdict, verdict);
  assert.equal(run.startArgs[run.startArgs.indexOf("--tools") + 1], "read,delivery_result_write"); assert.equal(run.startArgs[run.startArgs.indexOf("--delivery-result-mode") + 1], "review"); assert.equal(run.startArgs.includes("bash"), false); assert.equal(run.startArgs.includes("write"), false); assert.equal(run.startArgs.includes("edit"), false);
  const disposition = verdict === "approve" ? "approve" : verdict; const disposed = await run.core.dispose(run.fixture.root, { runId: "review-run", ticketId: "R1", disposition });
  assert.equal(disposed.details.tickets.R1.status, "disposed"); assert.equal(disposed.details.tickets.R1.disposition, disposition); assert.equal(disposed.details.tickets.R1.reviewResult.verdict, verdict);
  if (disposition === "approve") { assert.equal(disposed.details.phase, "awaiting_cleanup"); const cleaned = await run.core.cleanup(run.fixture.root, { runId: "review-run" }); assert.deepEqual(cleaned.details.cleaned, ["R1"]); assert.equal(run.removed, 1); }
  else { assert.equal(disposed.details.phase, "blocked"); const retained = await run.core.cleanup(run.fixture.root, { runId: "review-run" }); assert.deepEqual(retained.details.cleaned, []); assert.match(retained.details.retained[0].reason, new RegExp(`disposition ${disposition}`)); assert.equal(run.removed, 0); }
});

test("review mutation blocks, retains workspace, and never runs parent validation or auto-fix", async () => {
  const run = await scenario("approve", { mutateWorktree: true }); assert.equal(run.started.details.phase, "blocked"); assert.equal(run.started.details.tickets.R1.status, "blocked"); assert.match(run.started.details.tickets.R1.reason, /mutated worktree/); assert.equal(run.removed, 0);
  const dispose = await run.core.dispose(run.fixture.root, { runId: "review-run", ticketId: "R1", disposition: "approve" }); assert.equal(dispose.isError, true); assert.equal(dispose.details.status, "blocked");
});

test("unverifiable review state blocks and retains workspace", async () => {
  const run = await scenario("approve", { unknownAfter: true }); assert.equal(run.started.details.phase, "blocked"); assert.equal(run.started.details.tickets.R1.status, "blocked"); assert.match(run.started.details.tickets.R1.reason, /unverifiable/); assert.equal(run.removed, 0);
});
