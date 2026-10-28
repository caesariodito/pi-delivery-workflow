import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createDeliveryWorkflowCore } from "../extensions/delivery-workflow-core.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-fix-"));
  execFileSync("git", ["init", "-q"], { cwd: root }); execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root }); execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  fs.writeFileSync(path.join(root, ".gitignore"), ".scratch/\n"); fs.writeFileSync(path.join(root, "spec.md"), "spec\n"); execFileSync("git", ["add", "."], { cwd: root }); execFileSync("git", ["commit", "-qm", "test"], { cwd: root });
  return { root, sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), worktreeRoot: fs.mkdtempSync(path.join(os.tmpdir(), "delivery-fix-worktrees-")) };
}
function input(f, maxFixRounds = 1) { return { runId: "fix-run", objective: "Repair once", baseSha: f.sha, worktreeRoot: f.worktreeRoot, tickets: [{ id: "T1", goal: "Pass", definitionOfDone: "Validation passes", dependencies: [], ownedPaths: ["a.txt"], worker: { name: "worker", kind: "worker", model: "model", thinking: "medium", tools: ["read", "write"] }, validation: { executable: process.execPath, args: ["-e", "process.exit(require('fs').readFileSync('a.txt','utf8').trim()==='good'?0:1)"] }, specPaths: ["spec.md"], maxFixRounds, timeoutSeconds: 60, validationTimeoutSeconds: 30 }] }; }
function writeResult(file, status = "done") { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ version: 1, ticketId: "T1", status, summary: status, changedPaths: ["a.txt"], validation: status === "done" ? "passed" : "not_run", handoff: "result", question: null }), { flag: "wx" }); }
function fakeHerdr(f, { repair = true, initialStatus = "done", promptStatus = "done", promptThrows = false, liveAfterPrompt = ["done"], initialExtraFile = null } = {}) {
  let worktree; let bindingDir; let repairStarted = false; let liveIndex = 0; const prompts = []; const waits = [];
  return { prompts, waits,
    async status() {}, async integrationStatus() { return [{ name: "pi", status: "current (v1)" }]; },
    async worktreeCreate({ path: created }) { worktree = created; execFileSync("git", ["worktree", "add", "--detach", created, f.sha], { cwd: f.root, stdio: "ignore" }); return { path: created, pane: "p1", workspace: "w1" }; },
    async workspaceList() { return { workspaces: [{ workspace_id: "w1", worktree: { checkout_path: worktree } }] }; },
    async agentStart({ agentArgs }) { assert.equal(agentArgs[agentArgs.indexOf("--model") + 1], "model"); bindingDir = agentArgs[agentArgs.indexOf("--delivery-result-binding-dir") + 1]; fs.writeFileSync(path.join(worktree, "a.txt"), "bad\n"); if (initialExtraFile) fs.writeFileSync(path.join(worktree, initialExtraFile), "outside\n"); writeResult(agentArgs[agentArgs.indexOf("--delivery-result-path") + 1], initialStatus); },
    async agentGet() { const status = repairStarted ? liveAfterPrompt[Math.min(liveIndex++, liveAfterPrompt.length - 1)] : "done"; return { agent: { agent_status: status } }; },
    async agentWait({ timeout }) { waits.push(timeout); return { agent: { agent_status: "done" } }; },
    async agentPrompt({ target, prompt, wait }) { prompts.push({ target, prompt, wait }); repairStarted = true; const binding = JSON.parse(fs.readFileSync(path.join(bindingDir, "round-1.json"))); if (repair) fs.writeFileSync(path.join(worktree, "a.txt"), "good\n"); writeResult(binding.resultPath); if (promptThrows) throw new Error("prompt transport timeout"); return { agent: { agent_status: promptStatus } }; },
  };
}
async function run(f, herdr, value = input(f)) { const previous = process.env.HERDR_ENV; process.env.HERDR_ENV = "1"; try { return await createDeliveryWorkflowCore({ herdr, nonce: (() => { let n = 0; return () => `nonce-${n++}`; })() }).start(f.root, value); } finally { if (previous === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previous; } }

test("one same-agent repair uses fresh immutable prompt, result, log, nonce, and passes", async () => {
  const f = fixture(); const herdr = fakeHerdr(f); const output = await run(f, herdr);
  const ticket = output.details.tickets.T1; assert.equal(ticket.status, "validation_passed"); assert.equal(ticket.fixCount, 1); assert.equal(herdr.prompts.length, 1); assert.equal(herdr.prompts[0].target, "worker");
  assert.equal(ticket.rounds.length, 2); assert.notEqual(ticket.rounds[0].promptPath, ticket.rounds[1].promptPath); assert.notEqual(ticket.rounds[0].resultPath, ticket.rounds[1].resultPath); assert.notEqual(ticket.rounds[0].logPath, ticket.rounds[1].logPath);
  assert.equal(ticket.rounds[0].validation.passed, false); assert.equal(ticket.rounds[1].validation.passed, true);
  const bindings = [0, 1].map((round) => JSON.parse(fs.readFileSync(path.join(f.root, ".scratch", "delivery", "fix-run", "tickets", "T1", "result-bindings", `round-${round}.json`)))); assert.notEqual(bindings[0].nonce, bindings[1].nonce); assert.match(fs.readFileSync(ticket.rounds[1].promptPath, "utf8"), /Bounded output/);
});

test("working repair response waits for terminal live state even when result exists", async () => {
  const f = fixture(); const herdr = fakeHerdr(f, { promptStatus: "working", liveAfterPrompt: ["done"] }); const output = await run(f, herdr);
  assert.equal(output.details.tickets.T1.status, "validation_passed"); assert.equal(herdr.waits.length, 2);
});

test("repair prompt error reconciles working agent then waits", async () => {
  const f = fixture(); const herdr = fakeHerdr(f, { promptThrows: true, liveAfterPrompt: ["working", "done"] }); const output = await run(f, herdr);
  assert.equal(output.details.tickets.T1.status, "validation_passed"); assert.equal(herdr.waits.length, 2);
});

test("unknown repair state blocks without retry or replacement", async () => {
  const f = fixture(); const herdr = fakeHerdr(f, { promptStatus: "unknown", liveAfterPrompt: ["unknown"] }); const output = await run(f, herdr);
  assert.equal(output.details.tickets.T1.status, "blocked"); assert.match(output.details.tickets.T1.reason, /unknown state unknown/); assert.equal(herdr.prompts.length, 1); assert.equal(herdr.waits.length, 1);
});

test("repair exhaustion fails after one extra prompt", async () => {
  const f = fixture(); const herdr = fakeHerdr(f, { repair: false }); const output = await run(f, herdr); const ticket = output.details.tickets.T1;
  assert.equal(output.details.phase, "blocked"); assert.equal(ticket.status, "failed"); assert.match(ticket.reason, /fix rounds exhausted/); assert.equal(ticket.fixCount, 1); assert.equal(ticket.rounds.length, 2); assert.equal(herdr.prompts.length, 1);
});

test("blocked agent result is never repaired", async () => {
  const f = fixture(); const herdr = fakeHerdr(f, { initialStatus: "blocked" }); const output = await run(f, herdr);
  assert.equal(output.details.tickets.T1.status, "blocked"); assert.equal(herdr.prompts.length, 0);
});

test("pre-validation ownership violation executes no validation and no repair", async () => {
  const f = fixture(); const marker = path.join(f.root, "validation-ran"); const value = input(f); value.tickets[0].validation = { executable: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'yes')`] };
  const herdr = fakeHerdr(f, { initialExtraFile: "outside.txt" }); const output = await run(f, herdr, value);
  assert.equal(output.details.tickets.T1.status, "blocked"); assert.match(output.details.tickets.T1.reason, /ownership violation before validation/); assert.equal(fs.existsSync(marker), false); assert.equal(herdr.prompts.length, 0);
});

test("post-validation ownership violation rejects result and starts no repair", async () => {
  const f = fixture(); const value = input(f); value.tickets[0].validation = { executable: process.execPath, args: ["-e", "require('fs').writeFileSync('outside.txt','bad');process.exit(1)"] };
  const herdr = fakeHerdr(f); const output = await run(f, herdr, value);
  assert.equal(output.details.tickets.T1.status, "blocked"); assert.match(output.details.tickets.T1.reason, /ownership violation after validation/); assert.equal(herdr.prompts.length, 0);
});

test("result tool source keeps legacy flags and fail-closed round scoping", () => {
  const source = fs.readFileSync(new URL("../extensions/reviewer-result-tool.ts", import.meta.url), "utf8");
  assert.match(source, /delivery-result-binding-dir/); assert.match(source, /round-\[01\]/); assert.match(source, /binding advancement is invalid/); assert.match(source, /O_EXCL/); assert.match(source, /bindingDir === undefined/);
  const core = fs.readFileSync(new URL("../extensions/delivery-workflow-core.mjs", import.meta.url), "utf8"); assert.match(core, /validation\.timedOut \? "timed out" : "failed"/);
});
