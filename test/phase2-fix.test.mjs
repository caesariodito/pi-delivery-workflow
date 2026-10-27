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
function fakeHerdr(f, { repair = true, initialStatus = "done" } = {}) {
  let worktree; let bindingDir; const prompts = [];
  return { prompts,
    async status() {}, async integrationStatus() { return [{ name: "pi", status: "current (v1)" }]; },
    async worktreeCreate({ path: created }) { worktree = created; execFileSync("git", ["worktree", "add", "--detach", created, f.sha], { cwd: f.root, stdio: "ignore" }); return { path: created, pane: "p1", workspace: "w1" }; },
    async agentStart({ agentArgs }) { assert.equal(agentArgs[agentArgs.indexOf("--model") + 1], "model"); bindingDir = agentArgs[agentArgs.indexOf("--delivery-result-binding-dir") + 1]; fs.writeFileSync(path.join(worktree, "a.txt"), "bad\n"); writeResult(agentArgs[agentArgs.indexOf("--delivery-result-path") + 1], initialStatus); },
    async agentGet() { return { agent: { agent_status: "done" } }; },
    async agentPrompt({ target, prompt, wait }) { prompts.push({ target, prompt, wait }); const binding = JSON.parse(fs.readFileSync(path.join(bindingDir, "round-1.json"))); if (repair) fs.writeFileSync(path.join(worktree, "a.txt"), "good\n"); writeResult(binding.resultPath); return { agent: { agent_status: "done" } }; },
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

test("repair exhaustion fails after one extra prompt", async () => {
  const f = fixture(); const herdr = fakeHerdr(f, { repair: false }); const output = await run(f, herdr); const ticket = output.details.tickets.T1;
  assert.equal(output.details.phase, "blocked"); assert.equal(ticket.status, "failed"); assert.match(ticket.reason, /fix rounds exhausted/); assert.equal(ticket.fixCount, 1); assert.equal(ticket.rounds.length, 2); assert.equal(herdr.prompts.length, 1);
});

test("blocked agent result is never repaired", async () => {
  const f = fixture(); const herdr = fakeHerdr(f, { initialStatus: "blocked" }); const output = await run(f, herdr);
  assert.equal(output.details.tickets.T1.status, "blocked"); assert.equal(herdr.prompts.length, 0);
});

test("result tool source keeps legacy flags and fail-closed round scoping", () => {
  const source = fs.readFileSync(new URL("../extensions/reviewer-result-tool.ts", import.meta.url), "utf8");
  assert.match(source, /delivery-result-binding-dir/); assert.match(source, /round-\[01\]/); assert.match(source, /binding advancement is invalid/); assert.match(source, /O_EXCL/); assert.match(source, /bindingDir === undefined/);
  const core = fs.readFileSync(new URL("../extensions/delivery-workflow-core.mjs", import.meta.url), "utf8"); assert.match(core, /validation\.timedOut \? "timed out" : "failed"/);
});
