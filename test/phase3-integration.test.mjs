import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createDeliveryWorkflowCore } from "../extensions/delivery-workflow-core.mjs";

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-integration-"));
  execFileSync("git", ["init", "-q"], { cwd: root }); execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root }); execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  fs.writeFileSync(path.join(root, ".gitignore"), ".scratch/\n"); fs.writeFileSync(path.join(root, "spec.md"), "spec\n"); execFileSync("git", ["add", "."], { cwd: root }); execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
  return { root, sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), worktreeRoot: fs.mkdtempSync(path.join(os.tmpdir(), "delivery-worktrees-")) };
}

function input(fixture, args) {
  const ticket = (id, dependencies, ownedPath) => ({ id, goal: id, definitionOfDone: "Done", dependencies, ownedPaths: [ownedPath], worker: { name: `worker-${id.toLowerCase()}`, kind: "worker", model: "model", thinking: "medium", tools: ["read"] }, validation: { executable: "true", args: [] }, specPaths: ["spec.md"] });
  return { runId: "integration-run", objective: "Validate integrated parent", baseSha: fixture.sha, worktreeRoot: fixture.worktreeRoot, maxConcurrency: 1, integrationValidation: { executable: process.execPath, args, timeoutSeconds: 30 }, tickets: [ticket("T1", [], "a.txt"), ticket("T2", ["T1"], "b.txt")] };
}

async function scenario(args, mutateRun) {
  const fixture = repository(); const launches = [];
  const herdr = {
    async status() {}, async integrationStatus() { return [{ name: "pi", status: "current (v1)" }]; },
    async worktreeCreate({ path: worktreePath, base }) { execFileSync("git", ["worktree", "add", "--detach", worktreePath, base], { cwd: fixture.root }); return { path: worktreePath, pane: `pane-${path.basename(worktreePath)}`, workspace: `workspace-${path.basename(worktreePath)}` }; },
    async agentStart({ agentArgs }) { const resultPath = agentArgs[agentArgs.indexOf("--delivery-result-path") + 1]; const ticketId = path.basename(resultPath, ".json"); launches.push(ticketId); const worktreePath = path.join(fixture.worktreeRoot, `integration-run-${ticketId}`); fs.writeFileSync(path.join(worktreePath, ticketId === "T1" ? "a.txt" : "b.txt"), `${ticketId}\n`); fs.mkdirSync(path.dirname(resultPath), { recursive: true }); fs.writeFileSync(resultPath, JSON.stringify({ version: 1, ticketId, status: "done", summary: "done", changedPaths: [ticketId === "T1" ? "a.txt" : "b.txt"], validation: "passed", handoff: ticketId, question: null })); },
    async agentGet() { return { agent: { agent_status: "done" } }; },
  };
  const previous = process.env.HERDR_ENV; process.env.HERDR_ENV = "1";
  try {
    const core = createDeliveryWorkflowCore({ herdr }); const started = await core.start(fixture.root, input(fixture, args)); assert.equal(started.details.tickets.T1.status, "validation_passed"); assert.deepEqual(launches, ["T1"]);
    fs.writeFileSync(path.join(fixture.root, "a.txt"), "T1\n"); execFileSync("git", ["add", "a.txt"], { cwd: fixture.root }); execFileSync("git", ["commit", "-qm", "integrate"], { cwd: fixture.root }); const integratedSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.root, encoding: "utf8" }).trim();
    const runPath = path.join(fixture.root, ".scratch", "delivery", "integration-run", "run.json"); if (mutateRun) { const run = JSON.parse(fs.readFileSync(runPath)); mutateRun(run); fs.writeFileSync(runPath, `${JSON.stringify(run)}\n`); }
    return { output: await core.continue(fixture.root, { runId: "integration-run", integratedSha }), core, integratedSha, fixture, launches };
  } finally { if (previous === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previous; }
}

test("passing integration validation persists bounded evidence then launches downstream", async () => {
  const { output, launches } = await scenario(["-e", "process.stdout.write('ok')"]); assert.deepEqual(launches, ["T1", "T2"]); assert.equal(output.details.integrationValidation.passed, true); assert.equal(output.details.integrationValidation.before.clean, true); assert.equal(output.details.integrationValidation.after.clean, true); assert.deepEqual(output.details.integrationValidation.args, ["-e", "process.stdout.write('ok')"]); assert.ok(output.details.integrationValidation.timeoutMs === 30_000); assert.ok(fs.existsSync(output.details.integrationValidation.logPath));
});

test("failed integration validation blocks without marking progress or launching downstream", async () => {
  const { output, core, integratedSha, fixture, launches } = await scenario(["-e", "process.stderr.write('bad'); process.exit(7)"]); assert.equal(output.isError, true); assert.deepEqual(launches, ["T1"]); assert.equal(output.details.phase, "blocked"); assert.equal(output.details.tickets.T1.status, "validation_passed"); assert.equal(output.details.integrationValidation.code, 7); assert.equal(output.details.integrationValidation.stderrBytes, 3);
  const replay = await core.continue(fixture.root, { runId: "integration-run", integratedSha }); assert.equal(replay.details.status, "blocked"); assert.deepEqual(launches, ["T1"]);
});

test("timed out integration validation blocks downstream and records timeout", async () => {
  const { output, launches } = await scenario(["-e", "setInterval(() => {}, 1000)"], (run) => { run.integrationValidation.timeoutSeconds = 0.02; }); assert.deepEqual(launches, ["T1"]); assert.equal(output.details.phase, "blocked"); assert.equal(output.details.integrationValidation.timedOut, true); assert.match(output.details.integrationValidation.reason, /timed out/);
});

test("integration validation mutation blocks downstream and leaves ticket unintegrated", async () => {
  const { output, launches } = await scenario(["-e", "require('node:fs').writeFileSync('mutation.txt', 'x')"]); assert.deepEqual(launches, ["T1"]); assert.equal(output.details.phase, "blocked"); assert.equal(output.details.tickets.T1.status, "validation_passed"); assert.equal(output.details.integrationValidation.after.clean, false); assert.match(output.details.integrationValidation.reason, /mutated parent checkout/);
});
