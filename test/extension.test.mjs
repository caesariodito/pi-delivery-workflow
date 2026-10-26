import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import deliveryWorkflow from "../extensions/delivery-workflow.ts";
import { createDeliveryWorkflowCore, REVIEWER_MODEL, runDetachedDelivery, runStandaloneReview } from "../extensions/delivery-workflow-core.mjs";
import reviewerResultTool from "../extensions/reviewer-result-tool.ts";
import { createDeliveryRunner, RESULT_PROTOCOL } from "../extensions/lib/runner.mjs";

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

test("detached entry reconciles exact settled result before consuming inbox", async () => {
  const repository = root(); fs.writeFileSync(path.join(repository, "a.txt"), "base\n"); fs.writeFileSync(path.join(repository, ".gitignore"), ".scratch/\nworktree/\n");
  const { execFileSync } = await import("node:child_process"); const git = (...args) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid"); git("add", "."); git("commit", "-m", "base"); const sha = git("rev-parse", "HEAD");
  const dir = path.join(repository, ".scratch/delivery/run-1"); const ticketDir = path.join(dir, "T1"); fs.mkdirSync(path.join(dir, "inbox"), { recursive: true }); fs.mkdirSync(ticketDir);
  const ticket = { id: "T1", dependencies: [], batch: 1, ownedPaths: ["a.txt"], worktreePath: path.join(repository, "worktree"), branch: "ticket/T1", ticket: "work", context: "approved", forbiddenPaths: [], maxFixRounds: 1, worker: { name: "worker", kind: "pi", pane: "w:p1", session: "s" }, reviewer: { name: "reviewer", kind: "pi", pane: "w:p2", session: "r" }, artifactMappings: {} };
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ version: 1, runId: "run-1", repositoryPath: repository, baseSha: sha, tickets: [ticket], validation: { executable: process.execPath, args: ["-e", "process.exit(0)"] } }));
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ version: 1, runId: "run-1", baseSha: sha, phase: "active", tickets: { T1: { status: "active", attempt: 1, agent: { name: "worker-run-1", pane: "w:p1" }, worktree: ticket.worktreePath } }, completedSteps: [], nextAction: "settle", updatedAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(ticketDir, "state.json"), JSON.stringify({ version: 1, runId: "run-1", ticketId: "T1", phase: "review_waiting", target: "reviewer-run-1", candidateHash: "b".repeat(64) }));
  fs.writeFileSync(path.join(dir, "inbox/continue-1.json"), JSON.stringify({ version: 1, requestId: "continue-1", runId: "run-1", action: "continue", integratedSha: sha, createdAt: new Date().toISOString() }));
  const processRunner = { async run(spec) { try { return { code: 0, stdout: execFileSync(spec.executable, spec.args, { cwd: spec.cwd, encoding: null }), stderr: Buffer.alloc(0) }; } catch (error) { return { code: error.status, stdout: error.stdout ?? Buffer.alloc(0), stderr: error.stderr ?? Buffer.alloc(0) }; } } };
  let recovered = false;
  const final = await runDetachedDelivery(dir, { processRunner, herdr: {}, runnerOwner: { version: 1, pid: process.pid, processStart: "entry-test", runId: "run-1", createdAt: new Date().toISOString() }, isProcessAlive: () => false, runner: { async runTicket() { throw new Error("replacement forbidden"); }, async recoverSettledResult(_contract, expected) { recovered = true; assert.equal(expected.expectedTarget, "reviewer-run-1"); assert.equal(expected.expectedCandidateHash, "b".repeat(64)); return { status: "done", manifest: { pathHashes: { "a.txt": (await import("../extensions/lib/git-evidence.mjs")).sha256("base\n") } } }; } } });
  assert.equal(recovered, true); assert.equal(final.phase, "done"); assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "receipts/continue-1.json"))).status, "applied"); assert.equal(fs.existsSync(path.join(dir, "runner.lock")), false);
});

test("detached entry recovers real runner evidence before inbox without replacement launch", async () => {
  const repository = root(); fs.writeFileSync(path.join(repository, ".gitignore"), ".scratch/\nworktree/\n"); fs.writeFileSync(path.join(repository, "a.txt"), "base\n");
  const { execFileSync } = await import("node:child_process"); const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git(repository, "init", "-b", "main"); git(repository, "config", "user.name", "Test"); git(repository, "config", "user.email", "test@example.invalid"); git(repository, "add", "."); git(repository, "commit", "-m", "base"); const base = git(repository, "rev-parse", "HEAD");
  const worktree = path.join(repository, "worktree"); git(repository, "worktree", "add", "-b", "ticket/T1", worktree, base);
  const dir = path.join(repository, ".scratch/delivery/run-real"); const processRunner = { async run(spec) { try { return { code: 0, stdout: execFileSync(spec.executable, spec.args, { cwd: spec.cwd, encoding: null }), stderr: Buffer.alloc(0) }; } catch (error) { return { code: error.status, stdout: error.stdout ?? Buffer.alloc(0), stderr: error.stderr ?? Buffer.alloc(0) }; } } };
  let starts = 0; const herdr = { extractionVerdict: RESULT_PROTOCOL, async status() {}, async worktreeCreate() { return { path: worktree, pane: "w:p1" }; }, async agentStart() { starts += 1; }, async agentGet() { return { agent: { status: "done" } }; }, async agentPrompt(call) { const promptPath = call.prompt.match(/Read prompt file (.*) \(SHA-256/)[1]; const prompt = fs.readFileSync(promptPath, "utf8"); const resultPath = prompt.match(/Write JSON result to ([^\n]+) with mode 0600/)?.[1] ?? prompt.match(/scoped tool writes only ([^\n]+) with mode 0600/)?.[1]; if (prompt.startsWith("Immutable")) { fs.writeFileSync(path.join(worktree, "a.txt"), "changed\n"); fs.writeFileSync(resultPath, JSON.stringify({ version: 1, status: "done", summary: "done" }), { mode: 0o600 }); } else { const candidateHash = prompt.match(/Frozen candidate SHA-256: ([0-9a-f]{64})/)[1]; fs.writeFileSync(resultPath, JSON.stringify({ version: 1, verdict: "ok", findings: [], summary: "ok", candidateHash }), { mode: 0o600 }); } } };
  const contract = { version: 1, runId: "run-real", ticketId: "T1", planApproved: true, repositoryPath: repository, worktreePath: worktree, baseSha: base, branch: "ticket/T1", ticket: "change", context: "approved", ownedPaths: ["a.txt"], forbiddenPaths: [], validation: { executable: process.execPath, args: ["-e", "process.exit(0)"] }, maxFixRounds: 0, worker: { name: "worker", kind: "pi", pane: "w:p1", model: "worker-model", session: "s" }, reviewer: { name: "reviewer", kind: "pi", pane: "w:p2", model: "review-model", session: "r" }, artifactMappings: {} };
  const done = await createDeliveryRunner({ herdr, processRunner, random: (() => { let n = 0; return () => `n${++n}`; })() }).runTicket(contract); const launches = starts;
  fs.writeFileSync(path.join(repository, "a.txt"), "changed\n"); git(repository, "add", "a.txt"); git(repository, "commit", "-m", "integrate"); const integrated = git(repository, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ version: 1, runId: "run-real", repositoryPath: repository, baseSha: base, tickets: [{ ...contract, id: "T1", dependencies: [], batch: 1 }], validation: contract.validation })); fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ version: 1, runId: "run-real", baseSha: base, phase: "active", tickets: { T1: { status: "active", attempt: 1, agent: { name: "worker-run-real", pane: "w:p1" }, worktree } }, completedSteps: [], nextAction: "settle", updatedAt: new Date().toISOString() })); fs.mkdirSync(path.join(dir, "inbox")); fs.writeFileSync(path.join(dir, "inbox/continue-real.json"), JSON.stringify({ version: 1, requestId: "continue-real", runId: "run-real", action: "continue", integratedSha: integrated, createdAt: new Date().toISOString() }));
  const final = await runDetachedDelivery(dir, { processRunner, herdr, runnerOwner: { version: 1, pid: process.pid, processStart: "real-test", runId: "run-real", createdAt: new Date().toISOString() }, isProcessAlive: () => false });
  assert.equal(final.phase, "done"); assert.deepEqual(final.tickets.T1.manifest, done.manifest); assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "receipts/continue-real.json"))).status, "applied"); assert.equal(starts, launches);
});

test("detached entry blocks ambiguous ownership and duplicate live runner without consuming inbox", async () => {
  for (const scenario of ["incomplete", "live", "unknown"]) {
    const repository = root(); const dir = path.join(repository, ".scratch/delivery/run-1"); fs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ version: 1, runId: "run-1", repositoryPath: repository, baseSha: "a".repeat(40), tickets: [], validation: { executable: process.execPath, args: [] } }));
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ version: 1, runId: "run-1", baseSha: "a".repeat(40), phase: "active", tickets: { T1: { status: "active", attempt: 1 } }, completedSteps: [], nextAction: "wait", updatedAt: new Date().toISOString() }));
    fs.writeFileSync(path.join(dir, "inbox/stop-1.json"), "{}"); const owner = { version: 1, runId: "run-1", pid: 42, processStart: "old", createdAt: new Date().toISOString() }; fs.writeFileSync(path.join(dir, "runner.lock"), JSON.stringify(owner)); if (scenario !== "incomplete") fs.writeFileSync(path.join(dir, "runner.json"), JSON.stringify(owner));
    await assert.rejects(runDetachedDelivery(dir, { isProcessAlive: () => scenario === "live" ? true : scenario === "unknown" ? undefined : false }), scenario === "live" ? /live/ : scenario === "unknown" ? /unknown/ : /incomplete/);
    assert.equal(fs.existsSync(path.join(dir, "inbox/stop-1.json")), true); assert.equal(fs.existsSync(path.join(dir, "receipts/stop-1.json")), false);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "state.json"))); if (scenario !== "live") { assert.equal(saved.phase, "blocked"); assert.equal(saved.tickets.T1.status, "blocked"); } else assert.equal(saved.phase, "active");
  }
});

test("processInbox seam is serialized per runtime", async () => {
  const repository = root(); const dir = path.join(repository, ".scratch", "delivery", "r1"); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ phase: "active" }));
  let active = 0; let maximum = 0; const releases = [];
  const core = createDeliveryWorkflowCore({ processInbox: async () => { active += 1; maximum = Math.max(maximum, active); await new Promise((resolve) => releases.push(resolve)); active -= 1; } });
  const first = core.steer(repository, { runId: "r1", ticketId: "T1", message: "one" }); const second = core.steer(repository, { runId: "r1", ticketId: "T1", message: "two" });
  while (!releases.length) await new Promise((resolve) => setImmediate(resolve)); assert.equal(releases.length, 1); releases.shift()();
  while (!releases.length) await new Promise((resolve) => setImmediate(resolve)); assert.equal(maximum, 1); releases.shift()(); await Promise.all([first, second]); assert.equal(maximum, 1);
});
