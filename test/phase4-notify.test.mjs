import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createDeliveryWorkflowCore } from "../extensions/delivery-workflow-core.mjs";

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-notify-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  fs.writeFileSync(path.join(root, ".gitignore"), ".scratch/\n");
  fs.writeFileSync(path.join(root, "spec.md"), "spec\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "test"], { cwd: root });
  return { root, sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), worktreeRoot: fs.mkdtempSync(path.join(os.tmpdir(), "delivery-notify-worktrees-")) };
}

function input(fixture, validation = "true") {
  return { runId: "notify-run", objective: "Notify", baseSha: fixture.sha, worktreeRoot: fixture.worktreeRoot, tickets: [{
    id: "T1", goal: "Fail safely", definitionOfDone: "Outcome retained", dependencies: [], ownedPaths: ["a.txt"],
    worker: { name: "worker", kind: "worker", model: "model", thinking: "medium", tools: ["read"] },
    validation: { executable: validation, args: [], cwd: "." }, specPaths: ["spec.md"], maxFixRounds: 0,
  }] };
}

async function withHerdrEnvironment(run) {
  const previous = process.env.HERDR_ENV; process.env.HERDR_ENV = "1";
  try { return await run(); } finally { if (previous === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previous; }
}

function persistedTicket(fixture) {
  return JSON.parse(fs.readFileSync(path.join(fixture.root, ".scratch", "delivery", "notify-run", "status.json"), "utf8")).tickets.T1;
}

test("notifies only after blocked outcome persistence and keeps launch no-focus", async () => {
  const fixture = repository(); const calls = [];
  const herdr = {
    async status() {}, async integrationStatus() { return [{ name: "pi", status: "current (v1)" }]; },
    async worktreeCreate(options) { calls.push(["create", options]); assert.equal(options.focus, false); assert.equal("rename" in options, false); execFileSync("git", ["worktree", "add", "--detach", options.path, fixture.sha], { cwd: fixture.root }); return { path: options.path, pane: "w1:p1", workspace: "w1" }; },
    async agentStart() { throw new Error("launch failed"); }, async agentGet() { return { agent: { agent_status: "blocked" } }; },
    async workspaceList() { return { workspaces: [{ workspace_id: "w1", worktree: { checkout_path: path.join(fixture.worktreeRoot, "notify-run-T1") } }] }; },
    async notify(options) { calls.push(["notify", options]); assert.equal(persistedTicket(fixture).status, "blocked"); return { type: "ok" }; },
  };
  const output = await withHerdrEnvironment(() => createDeliveryWorkflowCore({ herdr }).start(fixture.root, input(fixture)));
  assert.equal(output.details.tickets.T1.status, "blocked"); assert.match(output.details.tickets.T1.reason, /^launch failed;/);
  assert.equal(output.details.tickets.T1.notification.status, "sent");
  assert.deepEqual(calls.map(([name]) => name), ["create", "notify"]);
  assert.deepEqual(calls[1][1], { title: "Delivery notify-run T1 blocked", body: output.details.tickets.T1.reason, sound: "request" });
});

test("notification failure is reported without replacing validation failure", async () => {
  const fixture = repository(); let worktreePath;
  const herdr = {
    async status() {}, async integrationStatus() { return [{ name: "pi", status: "current (v1)" }]; },
    async worktreeCreate(options) { assert.equal(options.focus, false); worktreePath = options.path; execFileSync("git", ["worktree", "add", "--detach", worktreePath, fixture.sha], { cwd: fixture.root }); return { path: worktreePath, pane: "w1:p1", workspace: "w1" }; },
    async agentStart({ agentArgs }) { const resultPath = agentArgs[agentArgs.indexOf("--delivery-result-path") + 1]; fs.mkdirSync(path.dirname(resultPath), { recursive: true }); fs.writeFileSync(resultPath, JSON.stringify({ version: 1, ticketId: "T1", status: "done", summary: "done", changedPaths: [], validation: "passed", handoff: "none", question: null })); },
    async agentGet() { return { agent: { agent_status: "done" } }; },
    async notify() { assert.equal(persistedTicket(fixture).status, "failed"); throw new Error("desktop unavailable"); },
  };
  const output = await withHerdrEnvironment(() => createDeliveryWorkflowCore({ herdr }).start(fixture.root, input(fixture, "false")));
  const ticket = output.details.tickets.T1;
  assert.equal(ticket.status, "failed"); assert.equal(ticket.reason, "validation failed; fix rounds exhausted");
  assert.deepEqual({ status: ticket.notification.status, error: ticket.notification.error }, { status: "failed", error: "desktop unavailable" });
  assert.equal(output.details.phase, "blocked"); assert.equal(output.isError, true);
});
