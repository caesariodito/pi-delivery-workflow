import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import deliveryWorkflow from "../extensions/delivery-workflow.ts";
import deliveryResultTool from "../extensions/reviewer-result-tool.ts";
import { createDeliveryWorkflowCore } from "../extensions/delivery-workflow-core.mjs";

function fakePi() { const tools = new Map(); const commands = new Map(); const flags = new Map(); return { tools, commands, flags, registerTool(tool) { tools.set(tool.name, tool); }, registerCommand(name, command) { commands.set(name, command); }, registerFlag(name) { if (!flags.has(name)) flags.set(name, undefined); }, getFlag(name) { return flags.get(name); }, sendUserMessage() {} }; }
function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: root }); execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root }); execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  fs.writeFileSync(path.join(root, ".gitignore"), ".scratch/\n"); fs.writeFileSync(path.join(root, "spec.md"), "spec\n"); execFileSync("git", ["add", "."], { cwd: root }); execFileSync("git", ["commit", "-qm", "test"], { cwd: root });
  return { root, sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), worktreeRoot: fs.mkdtempSync(path.join(os.tmpdir(), "delivery-worktrees-")) };
}
function runInput(sha, worktreeRoot) { return { runId: "run-1", objective: "Test launch", baseSha: sha, worktreeRoot, tickets: [
  { id: "T1", goal: "First", definitionOfDone: "Done", dependencies: [], ownedPaths: ["a.txt"], worker: { name: "worker-a", kind: "worker", model: "model", thinking: "medium", tools: ["read"] }, validation: { executable: "true", args: [], cwd: "." }, specPaths: ["spec.md"] },
  { id: "T2", goal: "Second", definitionOfDone: "Done", dependencies: ["T1"], ownedPaths: ["b.txt"], worker: { name: "reviewer-b", kind: "reviewer", model: "model", thinking: "medium", tools: ["read"] }, validation: { executable: "true", args: [] }, specPaths: ["generated-later.md"] },
] }; }

test("registers thin supervised tool surface", () => {
  const pi = fakePi(); deliveryWorkflow(pi);
  assert.deepEqual([...pi.tools.keys()].sort(), ["delivery_cleanup", "delivery_continue", "delivery_start", "delivery_status", "delivery_steer", "delivery_stop"]);
  assert.deepEqual(pi.tools.get("delivery_cleanup").annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
  assert.equal(pi.commands.has("delivery"), true); assert.equal(pi.tools.has("delivery_recover"), false); assert.equal(pi.tools.has("delivery_reply"), false); assert.equal(pi.tools.has("delivery_review"), false);
});

test("scoped result tool writes ticket result once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-result-")); const destination = path.join(root, "result.json"); const pi = fakePi(); pi.flags.set("delivery-result-path", destination); pi.flags.set("delivery-result-nonce", "nonce"); deliveryResultTool(pi); const tool = pi.tools.get("delivery_result_write");
  await tool.execute("id", { nonce: "nonce", ticketId: "T1", status: "done", summary: "done", changedPaths: ["src/a.js"], validation: "passed", handoff: "exports A", question: null });
  assert.equal(JSON.parse(fs.readFileSync(destination)).ticketId, "T1"); assert.throws(() => fs.writeFileSync(destination, "again", { flag: "wx" }));
});

test("launch defers dependent spec checks and removes worktree when agent start fails", async () => {
  const fixture = repository(); const calls = [];
  const herdr = { async status() {}, async integrationStatus() { return [{ name: "pi", status: "current (v1)" }]; }, async worktreeCreate({ path: worktreePath }) { calls.push("create"); return { path: worktreePath, pane: "w1:p1", workspace: "w1" }; }, async agentStart({ kind }) { assert.equal(kind, "pi"); throw new Error("agent launch failed"); }, async worktreeRemove({ workspace }) { calls.push(`remove:${workspace}`); } };
  const previous = process.env.HERDR_ENV; process.env.HERDR_ENV = "1";
  try { const output = await createDeliveryWorkflowCore({ herdr }).start(fixture.root, runInput(fixture.sha, fixture.worktreeRoot)); assert.equal(output.details.phase, "blocked"); assert.match(output.details.tickets.T1.reason, /worktree\/workspace removed/); assert.deepEqual(calls, ["create", "remove:w1"]); }
  finally { if (previous === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previous; }
});

test("launch passes ticket as Pi initial prompt instead of terminal input", async () => {
  const fixture = repository(); const calls = []; let polls = 0;
  const herdr = {
    async status() {}, async integrationStatus() { return [{ name: "pi", status: "current (v1)" }]; },
    async worktreeCreate({ path: worktreePath }) { return { path: worktreePath, pane: "w1:p1", workspace: "w1" }; },
    async agentStart({ agentArgs }) { calls.push("start"); const separator = agentArgs.lastIndexOf("--"); assert.ok(separator > 0); assert.match(agentArgs[separator + 1], /Read and follow the complete ticket context/); },
    async agentGet() { polls += 1; calls.push(`get:${polls}`); return { agent: { agent_status: polls > 2 ? "unknown" : polls > 1 ? "working" : "idle", interactive_ready: true } }; },
    async agentWait() { calls.push("wait"); throw new Error("stop after wait"); },
    async agentPrompt() { assert.fail("initial ticket must not use terminal prompt injection"); },
  };
  const previous = process.env.HERDR_ENV; process.env.HERDR_ENV = "1";
  try { const output = await createDeliveryWorkflowCore({ herdr }).start(fixture.root, runInput(fixture.sha, fixture.worktreeRoot)); assert.match(output.details.tickets.T1.reason, /unknown state unknown/); assert.deepEqual(calls, ["start", "get:1", "get:2", "wait", "get:3"]); }
  finally { if (previous === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previous; }
});

test("worktree root diagnostics run before Herdr launch checks", async () => {
  const fixture = repository(); let checked = false; const herdr = { async status() { checked = true; } }; const previous = process.env.HERDR_ENV; process.env.HERDR_ENV = "1";
  try { await assert.rejects(createDeliveryWorkflowCore({ herdr }).start(fixture.root, runInput(fixture.sha, path.join(fixture.root, "missing"))), /existing real directory outside the repository/); assert.equal(checked, false); }
  finally { if (previous === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previous; }
});

test("captures exact patch, verifies integration, and cleans idempotently", async () => {
  const fixture = repository(); const calls = []; let worktreePath; let failRemoval = true; const input = runInput(fixture.sha, fixture.worktreeRoot); input.tickets = [input.tickets[0]];
  const herdr = {
    async status() {}, async integrationStatus() { return [{ name: "pi", status: "current (v1)" }]; },
    async worktreeCreate({ path: createdPath }) { worktreePath = createdPath; execFileSync("git", ["worktree", "add", "--detach", createdPath, fixture.sha], { cwd: fixture.root }); return { path: createdPath, pane: "w1:p1", workspace: "w1" }; },
    async agentStart({ agentArgs }) { fs.writeFileSync(path.join(worktreePath, "a.txt"), "accepted\n"); const resultPath = agentArgs[agentArgs.indexOf("--delivery-result-path") + 1]; fs.mkdirSync(path.dirname(resultPath), { recursive: true }); fs.writeFileSync(resultPath, JSON.stringify({ version: 1, ticketId: "T1", status: "done", summary: "done", changedPaths: ["a.txt"], validation: "passed", handoff: "adds a", question: null })); },
    async agentGet() { return { agent: { agent_status: "done" } }; },
    async workspaceList() { return { workspaces: [{ workspace_id: "w1", agent_status: "idle", worktree: { checkout_path: worktreePath } }] }; },
    async worktreeRemove({ workspace, force }) { calls.push([workspace, force]); if (failRemoval) throw new Error("fixture removal failed"); execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: fixture.root }); return { type: "worktree_removed" }; },
  };
  const previous = process.env.HERDR_ENV; process.env.HERDR_ENV = "1";
  try {
    const core = createDeliveryWorkflowCore({ herdr }); const started = await core.start(fixture.root, input); assert.equal(started.details.tickets?.T1.status, "validation_passed", started.content[0].text);
    const patch = fs.readFileSync(path.join(fixture.root, ".scratch", "delivery", "run-1", "patches", "T1.patch")); assert.match(patch.toString(), /a\.txt/); assert.equal(started.details.tickets.T1.patchEvidence.sha256.length, 64);
    const refused = await core.cleanup(fixture.root, { runId: "run-1" }); assert.deepEqual(refused.details.cleaned, []); assert.match(refused.details.retained[0].reason, /validation_passed/);
    fs.writeFileSync(path.join(fixture.root, "a.txt"), "accepted\n"); execFileSync("git", ["add", "a.txt"], { cwd: fixture.root }); execFileSync("git", ["commit", "-qm", "integrate"], { cwd: fixture.root }); const integratedSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.root, encoding: "utf8" }).trim();
    const continued = await core.continue(fixture.root, { runId: "run-1", integratedSha }); assert.equal(continued.details.tickets?.T1.status, "integrated", continued.content[0].text); assert.equal(continued.details.phase, "awaiting_cleanup");
    const partial = await core.cleanup(fixture.root, { runId: "run-1" }); assert.equal(partial.details.status, "partial"); assert.match(partial.details.retained[0].reason, /fixture removal failed/); assert.equal(partial.isError, true);
    failRemoval = false; const cleaned = await core.cleanup(fixture.root, { runId: "run-1" }); assert.deepEqual(cleaned.details.cleaned, ["T1"]); assert.deepEqual(calls, [["w1", true], ["w1", true]]);
    const repeated = await core.cleanup(fixture.root, { runId: "run-1" }); assert.deepEqual(repeated.details.alreadyCleaned, ["T1"]); assert.deepEqual(calls, [["w1", true], ["w1", true]]);
  } finally { if (previous === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previous; }
});

test("status reports persisted ticket reasons and inactive controls stay inspection-only", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-core-")); const directory = path.join(root, ".scratch", "delivery", "run-1"); fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, "status.json"), JSON.stringify({ version: 1, runId: "run-1", phase: "blocked", tickets: { T1: { status: "blocked", reason: "agent launch failed" } } }));
  const core = createDeliveryWorkflowCore({ herdr: {} }); const status = await core.status(root, { runId: "run-1" }); assert.equal(status.details.phase, "blocked"); assert.match(status.content[0].text, /T1: agent launch failed/); assert.equal((await core.steer(root, { runId: "run-1", ticketId: "T1", message: "x" })).details.status, "not_active");
});
