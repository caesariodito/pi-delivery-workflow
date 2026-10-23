import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createScheduler, reconcileRunner } from "../extensions/lib/scheduler.mjs";

function runtime(state) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-")); fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(state)); return root; }
function schedulerState(ticket = {}) { return { version: 1, runId: "run-1", baseSha: "a".repeat(40), phase: "active", tickets: { T1: { status: "active", attempt: 1, agent: { name: "worker-run-1", pane: "w:p1" }, worktree: "/tmp/worktree", ...ticket } }, completedSteps: [], nextAction: "wait", updatedAt: "2026-01-01T00:00:00.000Z" }; }
function scheduler(root, herdr = {}) { return createScheduler({ repositoryPath: root, runtimeDir: root, processRunner: { run: async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }) }, herdr, runTicket: async () => ({ status: "done" }), runnerOwner: { version: 1, pid: process.pid, processStart: "test-process", runId: "run-1", createdAt: "2026-01-01T00:00:00.000Z" } }); }
function request(root, value, filename = value.requestId) { const inbox = path.join(root, "inbox"); fs.mkdirSync(inbox, { recursive: true }); fs.writeFileSync(path.join(inbox, `${filename}.json`), JSON.stringify(value)); }

test("runner reconciliation blocks live, unknown, and incomplete ownership", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-owner-"));
  assert.equal(reconcileRunner(root).status, "available");
  fs.writeFileSync(path.join(root, "runner.lock"), "{}"); assert.equal(reconcileRunner(root).status, "blocked");
  const owner = { version: 1, runId: "run-1", pid: 42, processStart: "start" }; fs.writeFileSync(path.join(root, "runner.lock"), JSON.stringify(owner)); fs.writeFileSync(path.join(root, "runner.json"), JSON.stringify(owner));
  assert.match(reconcileRunner(root, { isProcessAlive: () => true }).reason, /live/);
  assert.match(reconcileRunner(root).reason, /unknown/);
  assert.equal(reconcileRunner(root, { isProcessAlive: () => false }).status, "stale");
});

test("recovery uses exact retained identity once and never replaces writer", async () => {
  const root = runtime(schedulerState()); let calls = 0;
  const first = await scheduler(root).recover({ recoverTicket: async (id, ticket) => { calls += 1; assert.equal(id, "T1"); assert.equal(ticket.agent.name, "worker-run-1"); return { status: "recovered" }; } });
  assert.deepEqual(first.recovered, ["T1"]); assert.equal(calls, 1);
  const second = await scheduler(root).recover({ recoverTicket: async () => { calls += 1; } });
  assert.deepEqual(second.recovered, []); assert.equal(calls, 1);
  const ambiguousRoot = runtime(schedulerState({ agent: undefined })); const blocked = await scheduler(ambiguousRoot).recover({ recoverTicket: async () => { throw new Error("must not run"); } }); assert.equal(blocked.status, "blocked");
});

test("inbox claims once, writes receipts, rejects widening reply, and proves stop", async () => {
  const state = schedulerState({ status: "blocked", question: "Which approved wording?" }); const root = runtime(state); const calls = [];
  const herdr = { async agentPrompt(value) { calls.push(["prompt", value]); }, async agentSendKeys(value) { calls.push(["keys", value]); }, async agentWait() { return { agent: { status: "done" } }; } };
  request(root, { version: 1, requestId: "r1", runId: "run-1", action: "reply", ticketId: "T1", message: "add dependency package", createdAt: "2026-01-01T00:00:00.000Z" });
  const receipts = await scheduler(root, herdr).processInbox(); assert.equal(receipts[0].status, "rejected"); assert.match(receipts[0].reason, /widens/); assert.equal(calls.length, 0);
  assert.ok(fs.existsSync(path.join(root, "receipts/r1.json"))); assert.deepEqual(await scheduler(root, herdr).processInbox(), []);

  const stopRoot = runtime(schedulerState()); request(stopRoot, { version: 1, requestId: "r2", runId: "run-1", action: "stop", ticketId: "T1", createdAt: "2026-01-01T00:00:00.000Z" });
  const stopped = await scheduler(stopRoot, herdr).processInbox(); assert.equal(stopped[0].status, "applied"); assert.equal(JSON.parse(fs.readFileSync(path.join(stopRoot, "state.json"))).phase, "stopped"); assert.deepEqual(calls.at(-1), ["keys", { target: "worker-run-1", keys: ["C-c"] }]);

  const uncertainRoot = runtime(schedulerState()); request(uncertainRoot, { version: 1, requestId: "r3", runId: "run-1", action: "stop", ticketId: "T1", createdAt: "2026-01-01T00:00:00.000Z" });
  const uncertain = scheduler(uncertainRoot, { ...herdr, agentWait: async () => ({ agent: { status: "working" } }) }); await uncertain.processInbox(); assert.equal(JSON.parse(fs.readFileSync(path.join(uncertainRoot, "state.json"))).phase, "stop_unconfirmed");
});

test("duplicate and mismatched inbox requests never repeat effects", async () => {
  const root = runtime(schedulerState()); const calls = [];
  const herdr = { async agentPrompt(value) { calls.push(value); } };
  request(root, { version: 1, requestId: "r4", runId: "run-1", action: "steer", ticketId: "T1", message: "focus", createdAt: "2026-01-01T00:00:00.000Z" });
  await scheduler(root, herdr).processInbox();
  request(root, { version: 1, requestId: "r4", runId: "run-1", action: "steer", ticketId: "T1", message: "repeat", createdAt: "2026-01-01T00:00:00.000Z" });
  await scheduler(root, herdr).processInbox(); assert.equal(calls.length, 1);
  request(root, { version: 1, requestId: "different", runId: "run-1", action: "steer", ticketId: "T1", message: "bad", createdAt: "2026-01-01T00:00:00.000Z" }, "r5");
  const mismatch = await scheduler(root, herdr).processInbox(); assert.equal(mismatch[0].status, "rejected"); assert.match(mismatch[0].reason, /filename/); assert.equal(calls.length, 1);
});

test("recovery leaves ready state ready without manual intervention", async () => {
  const root = runtime(schedulerState({ status: "ready", agent: undefined, worktree: undefined }));
  const current = JSON.parse(fs.readFileSync(path.join(root, "state.json"))); current.phase = "ready"; current.nextAction = "start dependency-ready batch"; fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(current));
  let calls = 0;
  const result = await scheduler(root).recover({ recoverTicket: async () => { calls += 1; } });
  assert.deepEqual(result, { status: "ready", recovered: [] }); assert.equal(calls, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(root, "state.json"))); assert.equal(saved.phase, "ready"); assert.equal(saved.nextAction, "start dependency-ready batch"); assert.equal(fs.existsSync(path.join(root, "runner.lock")), false);
});

test("recovery converts stopping to stop_unconfirmed under exclusive lock", async () => {
  const root = runtime(schedulerState({ status: "stopping" }));
  const current = JSON.parse(fs.readFileSync(path.join(root, "state.json"))); current.phase = "stopping"; fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(current));
  const result = await scheduler(root).recover(); assert.equal(result.status, "stop_unconfirmed");
  const saved = JSON.parse(fs.readFileSync(path.join(root, "state.json"))); assert.equal(saved.phase, "stop_unconfirmed"); assert.equal(saved.tickets.T1.status, "stop_unconfirmed"); assert.equal(fs.existsSync(path.join(root, "runner.lock")), false);
});
