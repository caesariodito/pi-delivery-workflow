import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createScheduler, readyTickets, validateTicketGraph, verifyIntegration } from "../extensions/lib/scheduler.mjs";
import { sha256 } from "../extensions/lib/git-evidence.mjs";

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-"));
  git(root, "init", "-b", "main"); git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(root, "a.txt"), "base\n"); git(root, "add", "."); git(root, "commit", "-m", "base"); return root;
}
function processRunner() { return { async run(spec) { try { return { code: 0, stdout: execFileSync(spec.executable, spec.args, { cwd: spec.cwd, encoding: null }), stderr: Buffer.alloc(0) }; } catch (error) { return { code: error.status, stdout: error.stdout ?? Buffer.alloc(0), stderr: error.stderr ?? Buffer.alloc(0) }; } } }; }
function tickets(root) { return [
  { id: "T1", dependencies: [], batch: 1, ownedPaths: ["src/a.js"], worktreePath: path.join(root, "w1"), worker: { name: "worker-t1", pane: "w:p1" } },
  { id: "T2", dependencies: [], batch: 1, ownedPaths: ["src/b.js"], worktreePath: path.join(root, "w2"), worker: { name: "worker-t2", pane: "w:p2" } },
  { id: "T3", dependencies: ["T1", "T2"], batch: 2, ownedPaths: ["src/c.js"], worktreePath: path.join(root, "w3"), worker: { name: "worker-t3", pane: "w:p3" } },
]; }
function state(root, graph, overrides = {}) {
  const runtime = path.join(root, "runtime"); fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, "state.json"), JSON.stringify({ version: 1, runId: "run-1", baseSha: git(root, "rev-parse", "HEAD"), phase: "ready", tickets: Object.fromEntries(graph.map((item) => [item.id, { status: "ready", attempt: 0 }])), completedSteps: [], nextAction: "start", updatedAt: new Date().toISOString(), ...overrides }));
  return runtime;
}

test("graph enforces dependencies, batches, worktrees, and concurrent ownership", () => {
  const root = repo(); const valid = validateTicketGraph(tickets(root)); assert.ok(Object.isFrozen(valid));
  assert.deepEqual(readyTickets(valid, { T1: { status: "ready" }, T2: { status: "ready" }, T3: { status: "ready" } }), ["T1", "T2"]);
  assert.throws(() => validateTicketGraph([...tickets(root), { id: "T4", dependencies: ["missing"], batch: 2, ownedPaths: ["x"], worktreePath: path.join(root, "w4"), worker: { name: "worker-t4", pane: "w:p4" } }]), /unknown/);
  assert.throws(() => validateTicketGraph(tickets(root).map((item) => item.id === "T2" ? { ...item, ownedPaths: ["src/"] } : item)), /overlapping/);
  assert.throws(() => validateTicketGraph(tickets(root).map((item) => item.id === "T2" ? { ...item, worktreePath: path.join(root, "w1") } : item)), /share a worktree/);
});

test("batch siblings settle together and dependent batch waits for integration", async () => {
  const root = repo(); const graph = tickets(root); const runtimeDir = state(root, graph); const launched = [];
  const scheduler = createScheduler({ repositoryPath: root, runtimeDir, processRunner: processRunner(), herdr: {}, runTicket: async (ticket) => { const persisted = JSON.parse(fs.readFileSync(path.join(runtimeDir, "state.json"))); assert.deepEqual(persisted.tickets[ticket.id].agent, { name: `${ticket.worker.name}-run-1`, pane: ticket.worker.pane }); launched.push(ticket.id); return { status: "done", manifest: { pathHashes: { "a.txt": sha256("base\n") } } }; } });
  const result = await scheduler.startBatch(graph);
  assert.equal(result.status, "awaiting_integration"); assert.deepEqual(launched.sort(), ["T1", "T2"]);
  const saved = JSON.parse(fs.readFileSync(path.join(runtimeDir, "state.json"))); assert.equal(saved.phase, "awaiting_integration"); assert.equal(saved.tickets.T3.status, "ready"); assert.equal(saved.tickets.T1.status, "done"); assert.equal(saved.tickets.T2.status, "done");
});

test("integration verifies clean ancestry, path bytes, then argv validation", async () => {
  const root = repo(); const base = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "a.txt"), "integrated\n"); git(root, "add", "."); git(root, "commit", "-m", "integrate"); const head = git(root, "rev-parse", "HEAD");
  const evidence = await verifyIntegration({ previousBaseSha: base, integratedSha: head, manifests: [{ pathHashes: { "a.txt": sha256("integrated\n") } }], repositoryPath: root, validation: { executable: process.execPath, args: ["-e", "process.exit(0)"] } }, { processRunner: processRunner() });
  assert.deepEqual(evidence.verifiedPaths, ["a.txt"]);
  await assert.rejects(verifyIntegration({ previousBaseSha: base, integratedSha: head, manifests: [{ pathHashes: { "a.txt": sha256("wrong") } }], repositoryPath: root, validation: { executable: process.execPath, args: ["-e", "process.exit(0)"] } }, { processRunner: processRunner() }), /hash mismatch/);
  await assert.rejects(verifyIntegration({ previousBaseSha: base, integratedSha: base, manifests: [{ pathHashes: { "a.txt": sha256("base\n") } }], repositoryPath: root, validation: { executable: process.execPath, args: ["-e", "process.exit(0)"] } }, { processRunner: processRunner() }), /HEAD mismatch/);
  await assert.rejects(verifyIntegration({ previousBaseSha: "f".repeat(40), integratedSha: head, manifests: [{ pathHashes: { "a.txt": sha256("integrated\n") } }], repositoryPath: root, validation: { executable: process.execPath, args: ["-e", "process.exit(0)"] } }, { processRunner: processRunner() }), /merge-base/);
  await assert.rejects(verifyIntegration({ previousBaseSha: base, integratedSha: head, manifests: [{ pathHashes: { "a.txt": sha256("integrated\n") } }], repositoryPath: root, validation: { executable: process.execPath, args: [], cwd: "../escape" } }, { processRunner: processRunner() }), /traverse|escapes/);
  fs.writeFileSync(path.join(root, "dirty"), "x");
  await assert.rejects(verifyIntegration({ previousBaseSha: base, integratedSha: head, manifests: [{ pathHashes: { "a.txt": sha256("integrated\n") } }], repositoryPath: root, validation: { executable: process.execPath, args: ["-e", "process.exit(0)"] } }, { processRunner: processRunner() }), /clean/);
});

test("stop race preserves stopped state after sibling settlement", async () => {
  const root = repo(); const graph = tickets(root); const runtimeDir = state(root, graph); const releases = [];
  const herdr = { async agentSendKeys() {}, async agentWait() { return { agent: { status: "done" } }; } };
  const scheduler = createScheduler({ repositoryPath: root, runtimeDir, processRunner: processRunner(), herdr, runTicket: (ticket) => new Promise((resolve) => releases.push(() => resolve({ status: "done", manifest: { pathHashes: { [ticket.id]: sha256(ticket.id) } } }))) });
  const batch = scheduler.startBatch(graph);
  while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
  const inbox = path.join(runtimeDir, "inbox"); fs.mkdirSync(inbox); fs.writeFileSync(path.join(inbox, "stop-race.json"), JSON.stringify({ version: 1, requestId: "stop-race", runId: "run-1", action: "stop", createdAt: "2026-01-01T00:00:00.000Z" }));
  await scheduler.processInbox(); releases.forEach((release) => release());
  const result = await batch; assert.equal(result.status, "stopped");
  const saved = JSON.parse(fs.readFileSync(path.join(runtimeDir, "state.json"))); assert.equal(saved.phase, "stopped"); assert.ok([saved.tickets.T1.status, saved.tickets.T2.status].every((status) => status === "stopped"));
});

test("done without nonempty manifest blocks and waiting dependency does not launch", async () => {
  const root = repo(); const graph = tickets(root); const runtimeDir = state(root, graph, { tickets: { T1: { status: "ready", attempt: 0 }, T2: { status: "blocked", attempt: 0 }, T3: { status: "ready", attempt: 0 } } });
  const launched = [];
  const result = await createScheduler({ repositoryPath: root, runtimeDir, processRunner: processRunner(), herdr: {}, runTicket: async (ticket) => { launched.push(ticket.id); return { status: "done", manifest: { pathHashes: {} } }; } }).startBatch(graph);
  assert.deepEqual(launched, ["T1"]); assert.equal(result.status, "blocked");
  const saved = JSON.parse(fs.readFileSync(path.join(runtimeDir, "state.json"))); assert.equal(saved.tickets.T1.status, "blocked"); assert.equal(saved.tickets.T3.status, "ready");
});
