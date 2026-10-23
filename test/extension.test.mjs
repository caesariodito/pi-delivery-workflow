import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import deliveryWorkflow from "../extensions/delivery-workflow.ts";
import { createDeliveryWorkflowCore, REVIEWER_MODEL, runStandaloneReview } from "../extensions/delivery-workflow-core.mjs";
import reviewerResultTool from "../extensions/reviewer-result-tool.ts";

function root() { const value = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-extension-")); fs.mkdirSync(path.join(value, ".scratch")); return value; }
function api() { const tools = new Map(); const commands = new Map(); return { tools, commands, registerTool(value) { tools.set(value.name, value); }, registerCommand(name, value) { commands.set(name, value); }, sendUserMessage() {} }; }

test("registers bounded model-callable tools and command wrappers", () => {
  const pi = api(); deliveryWorkflow(pi);
  const names = ["delivery_review", "delivery_start", "delivery_status", "delivery_steer", "delivery_reply", "delivery_continue", "delivery_stop"];
  assert.deepEqual([...pi.tools.keys()], names); for (const name of names) assert.ok(pi.commands.has(name)); assert.ok(pi.commands.has("delivery"));
  assert.equal(pi.tools.get("delivery_review").parameters.additionalProperties, false); assert.equal(pi.tools.get("delivery_steer").parameters.properties.message.maxLength, 16_000);
});

test("review prevalidates inputs then pins model/tools and detached argv without shell", async () => {
  const repository = root(); const calls = []; fs.writeFileSync(path.join(repository, ".scratch/a.md"), "artifact"); fs.writeFileSync(path.join(repository, ".scratch/c.md"), "context");
  const core = createDeliveryWorkflowCore({ random: () => "nonce", spawnProcess(executable, args, options) { calls.push({ executable, args, options }); return { pid: 42, unref() { calls.push("unref"); } }; } });
  await assert.rejects(core.review(repository, { runId: "bad", kind: "plan", artifact: ".scratch/missing.md", contextBundle: ".scratch/c.md" }), /ENOENT/); assert.equal(calls.length, 0);
  const output = await core.review(repository, { runId: "r1", kind: "plan", artifact: ".scratch/a.md", contextBundle: ".scratch/c.md" });
  assert.equal(output.details.model, REVIEWER_MODEL); assert.deepEqual(output.details.tools, ["read", "grep", "find", "ls"]); assert.equal(calls[0].executable, process.execPath); assert.equal(calls[0].options.detached, true); assert.equal(calls[0].options.shell, false); assert.deepEqual(calls[0].options.stdio, "ignore"); assert.equal(calls[1], "unref");
});

test("standalone review initialization failures persist exclusive blocked status without launch", async () => {
  for (const scenario of ["missing-artifact", "malformed-request", "herdr-status"]) {
    const repository = root(); const directory = path.join(repository, ".scratch/delivery/r1"); fs.mkdirSync(directory, { recursive: true }); const requestPath = path.join(directory, `review-${scenario}.json`); const calls = [];
    fs.writeFileSync(path.join(repository, ".scratch/context.md"), "context"); fs.writeFileSync(path.join(repository, ".scratch/artifact.md"), "artifact");
    if (scenario === "malformed-request") fs.writeFileSync(requestPath, "{bad");
    else fs.writeFileSync(requestPath, JSON.stringify({ runId: "r1", kind: "plan", artifact: scenario === "missing-artifact" ? ".scratch/missing.md" : ".scratch/artifact.md", contextBundle: ".scratch/context.md" }));
    const herdr = { async status() { calls.push("status"); if (scenario === "herdr-status") throw new Error("Herdr unavailable"); }, async worktreeCreate() { calls.push("worktreeCreate"); }, async agentStart() { calls.push("agentStart"); } };
    await assert.rejects(runStandaloneReview(requestPath, { cwd: repository, herdr }), scenario === "malformed-request" ? /JSON/ : scenario === "herdr-status" ? /Herdr unavailable/ : /ENOENT/);
    const statusPath = path.join(directory, `review-${scenario}-status.json`); const status = JSON.parse(fs.readFileSync(statusPath)); assert.equal(status.version, 1); assert.equal(status.phase, "blocked"); assert.equal(typeof status.reason, "string"); assert.match(status.updatedAt, /^\d{4}-/); assert.equal(fs.statSync(statusPath).mode & 0o777, 0o600); assert.equal(calls.includes("worktreeCreate"), false); assert.equal(calls.includes("agentStart"), false);
    const original = fs.readFileSync(statusPath, "utf8"); await assert.rejects(runStandaloneReview(requestPath, { cwd: repository, herdr })); assert.equal(fs.readFileSync(statusPath, "utf8"), original);
  }
});

test("status detects legacy read-only and control refuses it", async () => {
  const repository = root(); fs.mkdirSync(path.join(repository, ".scratch", "pi-subagents")); const core = createDeliveryWorkflowCore();
  const status = await core.status(repository, { runId: "old" }); assert.equal(status.details.status, "unsupported"); assert.match(status.content[0].text, /Legacy pi-subagents/);
  const reply = await core.reply(repository, { runId: "old", ticketId: "T1", message: "yes" }); assert.equal(reply.isError, true); assert.equal(reply.details.status, "unsupported");
  const continued = await core.continue(repository, { runId: "old", integratedSha: "a".repeat(40) }); assert.equal(continued.isError, true);
  const stopped = await core.stop(repository, { runId: "old" }); assert.equal(stopped.isError, true);
});

test("start validates complete ticket contract before exclusive claim and omits undefined concurrency", async () => {
  const repository = root(); const calls = []; const worktree = path.join(repository, "worktree");
  const core = createDeliveryWorkflowCore({ spawnProcess(executable, args, options) { calls.push({ executable, args, options }); return { pid: 9, unref() {} }; } });
  const input = { runId: "run-1", baseSha: "a".repeat(40), validation: { executable: process.execPath, args: ["--version"] }, tickets: JSON.stringify([{ id: "T1", dependencies: [], batch: 1, ownedPaths: ["src/a.ts"], worktreePath: worktree, branch: "ticket/T1", ticket: "Do work", context: "Approved", forbiddenPaths: [], maxFixRounds: 1, worker: { name: "worker", kind: "pi", pane: "w:p1", session: "s" }, reviewer: { name: "reviewer", kind: "pi", pane: "w:p2", session: "r" }, artifactMappings: {} }]) };
  const bad = structuredClone(input); bad.tickets = JSON.stringify([{ id: "T1", dependencies: [], batch: 1, ownedPaths: ["src/a.ts"], worktreePath: worktree, worker: { name: "worker", pane: "w:p1" } }]);
  await assert.rejects(core.start(repository, bad), /maxFixRounds|branch|ticket|context/); assert.equal(fs.existsSync(path.join(repository, ".scratch/delivery/run-1")), false); assert.equal(calls.length, 0);
  const output = await core.start(repository, input); assert.equal(output.details.status, "launched"); const config = JSON.parse(fs.readFileSync(path.join(repository, ".scratch/delivery/run-1/config.json"))); assert.equal("maxConcurrency" in config, false); assert.equal(config.tickets[0].id, "T1");
  const duplicate = await core.start(repository, input); assert.equal(duplicate.details.status, "exists"); assert.equal(calls.length, 1);
});

test("controls require existing current state", async () => {
  const repository = root(); const core = createDeliveryWorkflowCore(); const missing = await core.stop(repository, { runId: "none" }); assert.equal(missing.details.status, "not_found"); assert.equal(fs.existsSync(path.join(repository, ".scratch/delivery/none")), false);
});

test("scoped reviewer result tool writes exact 0600 path once and rejects mismatches", async () => {
  const repository = root(); const target = path.join(repository, "result.json"); let tool; const flags = new Map([["delivery-result-path", target], ["delivery-result-nonce", "nonce-1"]]);
  reviewerResultTool({ registerFlag() {}, registerTool(value) { tool = value; }, getFlag(name) { return flags.get(name); } });
  const input = { nonce: "nonce-1", verdict: "ok", findings: [], summary: "clean", candidateHash: "a".repeat(64) };
  await tool.execute("call", input); assert.equal(fs.statSync(target).mode & 0o777, 0o600); assert.equal(JSON.parse(fs.readFileSync(target)).nonce, undefined); assert.equal("path" in tool.parameters.properties, false);
  await assert.rejects(tool.execute("call-2", input), /EEXIST/);
  const other = root(); flags.set("delivery-result-path", path.join(other, "other.json")); flags.set("delivery-result-nonce", "nonce-2"); await assert.rejects(tool.execute("call-3", input), /nonce mismatch/);
});

test("processInbox seam is serialized per runtime", async () => {
  const repository = root(); const dir = path.join(repository, ".scratch", "delivery", "r1"); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ phase: "active" }));
  let active = 0; let maximum = 0; const releases = [];
  const core = createDeliveryWorkflowCore({ processInbox: async () => { active += 1; maximum = Math.max(maximum, active); await new Promise((resolve) => releases.push(resolve)); active -= 1; } });
  const first = core.steer(repository, { runId: "r1", ticketId: "T1", message: "one" }); const second = core.steer(repository, { runId: "r1", ticketId: "T1", message: "two" });
  while (!releases.length) await new Promise((resolve) => setImmediate(resolve)); assert.equal(releases.length, 1); releases.shift()();
  while (!releases.length) await new Promise((resolve) => setImmediate(resolve)); assert.equal(maximum, 1); releases.shift()(); await Promise.all([first, second]); assert.equal(maximum, 1);
});
