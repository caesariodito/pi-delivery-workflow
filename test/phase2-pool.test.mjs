import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createDeliveryWorkflowCore } from "../extensions/delivery-workflow-core.mjs";

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-pool-"));
  execFileSync("git", ["init", "-q"], { cwd: root }); execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root }); execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  fs.writeFileSync(path.join(root, ".gitignore"), ".scratch/\n"); fs.writeFileSync(path.join(root, "spec.md"), "spec\n"); execFileSync("git", ["add", "."], { cwd: root }); execFileSync("git", ["commit", "-qm", "test"], { cwd: root });
  return { root, sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), worktreeRoot: fs.mkdtempSync(path.join(os.tmpdir(), "delivery-pool-worktrees-")) };
}
function ticket(id, dependencies = [], requiresIntegratedBase = false) { return { id, goal: id, definitionOfDone: "Done", dependencies, ownedPaths: [`${id}.txt`], requiresIntegratedBase, worker: { name: id.toLowerCase(), kind: "worker", model: "model", thinking: "medium", tools: ["read"] }, validation: { executable: "true", args: [] }, specPaths: ["spec.md"] }; }
function input(f, tickets, maxConcurrency = 2) { return { runId: "pool-run", objective: "Test active pool", baseSha: f.sha, worktreeRoot: f.worktreeRoot, maxConcurrency, tickets }; }
function fakeHerdr(f, gates, statuses = {}) {
  const starts = []; let active = 0; let maximum = 0;
  return { starts, get maximum() { return maximum; },
    async status() {}, async integrationStatus() { return [{ name: "pi", status: "current (v1)" }]; },
    async worktreeCreate({ path: worktreePath }) { execFileSync("git", ["worktree", "add", "--detach", worktreePath, f.sha], { cwd: f.root, stdio: "ignore" }); const id = path.basename(worktreePath).split("-").at(-1); return { path: worktreePath, pane: `pane-${id}`, workspace: `workspace-${id}` }; },
    async agentStart({ name, agentArgs }) { starts.push(name.toUpperCase()); active += 1; maximum = Math.max(maximum, active); const resultPath = agentArgs[agentArgs.indexOf("--delivery-result-path") + 1]; fs.mkdirSync(path.dirname(resultPath), { recursive: true }); fs.writeFileSync(resultPath, JSON.stringify({ version: 1, ticketId: name.toUpperCase(), status: statuses[name.toUpperCase()] ?? "done", summary: "settled", changedPaths: [], validation: statuses[name.toUpperCase()] === "failed" ? "failed" : "passed", handoff: "done", question: null })); },
    async agentGet(name) { await gates[name.toUpperCase()].promise; active -= 1; return { agent: { agent_status: "done" } }; },
  };
}
async function until(predicate) { for (let index = 0; index < 100; index += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } assert.fail("condition not reached"); }

async function withHerdrEnvironment(action) { const previous = process.env.HERDR_ENV; process.env.HERDR_ENV = "1"; try { return await action(); } finally { if (previous === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previous; } }

test("active pool refills immediately, respects cap, and persists lifecycle timing", async () => withHerdrEnvironment(async () => {
  const f = fixture(); const gates = Object.fromEntries(["T1", "T2", "T3"].map((id) => [id, deferred()])); const herdr = fakeHerdr(f, gates); const running = createDeliveryWorkflowCore({ herdr }).start(f.root, input(f, [ticket("T1"), ticket("T2"), ticket("T3")]));
  await until(() => herdr.starts.length === 2); assert.equal(herdr.maximum, 2);
  gates.T1.resolve(); await until(() => herdr.starts.length === 3); assert.deepEqual(herdr.starts, ["T1", "T2", "T3"]); assert.equal(herdr.maximum, 2);
  gates.T2.resolve(); gates.T3.resolve(); const output = await running; assert.equal(output.details.phase, "awaiting_integration");
  for (const state of Object.values(output.details.tickets)) { assert.ok(state.queuedAt); assert.ok(state.launchStartedAt); assert.ok(state.startedAt); assert.ok(state.settledAt); assert.ok(state.queuedAt <= state.launchStartedAt); assert.ok(state.launchStartedAt <= state.settledAt); }
}));

test("failure stops new launches but drains active tickets", async () => withHerdrEnvironment(async () => {
  const f = fixture(); const gates = Object.fromEntries(["T1", "T2", "T3"].map((id) => [id, deferred()])); const herdr = fakeHerdr(f, gates, { T1: "failed" }); let settled = false; const running = createDeliveryWorkflowCore({ herdr }).start(f.root, input(f, [ticket("T1"), ticket("T2"), ticket("T3")])).then((value) => { settled = true; return value; });
  await until(() => herdr.starts.length === 2); gates.T1.resolve(); await until(() => JSON.parse(fs.readFileSync(path.join(f.root, ".scratch", "delivery", "pool-run", "status.json"))).tickets.T1.settledAt); assert.deepEqual(herdr.starts, ["T1", "T2"]); assert.equal(settled, false);
  gates.T2.resolve(); const output = await running; assert.equal(output.details.phase, "blocked"); assert.equal(output.details.tickets.T3.status, "pending"); assert.ok(output.details.tickets.T2.settledAt);
}));

test("integration requirement remains a launch barrier", async () => withHerdrEnvironment(async () => {
  const f = fixture(); const gates = { T1: deferred(), T2: deferred() }; const herdr = fakeHerdr(f, gates); const running = createDeliveryWorkflowCore({ herdr }).start(f.root, input(f, [ticket("T1"), ticket("T2", ["T1"], true)]));
  await until(() => herdr.starts.length === 1); gates.T1.resolve(); const output = await running; assert.deepEqual(herdr.starts, ["T1"]); assert.equal(output.details.phase, "awaiting_integration"); assert.equal(output.details.tickets.T2.status, "pending");
}));
