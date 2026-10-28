import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDeliveryWorkflowCore } from "../extensions/delivery-workflow-core.mjs";

const statuses = ["pending", "running", "validation_passed", "integrated", "cleaned", "blocked", "failed", "stopped", "timed_out"];

function fixture(tickets, definitions = Object.keys(tickets).map((id) => ({ id, mode: "implementation", dependencies: [] }))) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-status-")); const directory = path.join(root, ".scratch", "delivery", "run-1"); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "status.json"), `${JSON.stringify({ version: 2, runId: "run-1", phase: "blocked", tickets }, null, 2)}\n`);
  fs.writeFileSync(path.join(directory, "run.json"), `${JSON.stringify({ version: 2, runId: "run-1", maxConcurrency: 2, tickets: definitions }, null, 2)}\n`);
  return { root, statusPath: path.join(directory, "status.json") };
}

async function statusOf(run) {
  const before = fs.readFileSync(run.statusPath); const output = await createDeliveryWorkflowCore({ herdr: {} }).status(run.root, { runId: "run-1" }); assert.deepEqual(fs.readFileSync(run.statusPath), before); return output;
}

test("status reports every lifecycle class and retained resources without mutation", async () => {
  const tickets = Object.fromEntries(statuses.map((status, index) => [`T${index}`, { status, ...(status !== "cleaned" && index % 2 ? { workspace: `w${index}`, worktreePath: `/tmp/w${index}` } : {}) }]));
  const output = await statusOf(fixture(tickets));
  assert.deepEqual(output.details.lifecycle, { pending: 1, running: 1, validationPassed: 1, integrated: 1, cleaned: 1, blocked: 1, failed: 1, stopped: 1, timedOut: 1 });
  assert.deepEqual(output.details.retainedResources, ["T1", "T3", "T5", "T7"]); assert.equal(output.details.counts.retainedResources, 4);
  assert.match(output.content[0].text, /validation-passed 1/); assert.match(output.content[0].text, /timed-out 1/); assert.match(output.content[0].text, /retained resources 4/);
});

test("status reports structured review verdicts and exact disposition action", async () => {
  const tickets = { R3: { status: "reviewed", verdict: "blocked" }, R1: { status: "reviewed", reviewResult: { verdict: "approve" } }, R2: { status: "disposed", disposition: "changes_requested", verdict: "changes_requested", workspace: "w2" } };
  const definitions = Object.keys(tickets).map((id) => ({ id, mode: "review", dependencies: [] })); const output = await statusOf(fixture(tickets, definitions));
  assert.deepEqual(output.details.reviewVerdicts, { approve: 1, changes_requested: 1, blocked: 1 });
  assert.equal(output.details.nextAction, "Run delivery_dispose for: R1, R3."); assert.match(output.content[0].text, /Review verdicts: approve 1; changes_requested 1; blocked 1/);
});

test("status exposes incomplete metrics without guessed zeroes", async () => {
  const tickets = { A: { status: "validation_passed", queuedAt: "2025-01-01T00:00:00Z", settledAt: "2025-01-01T00:00:01Z", timing: { workerElapsedMs: 500, totalElapsedMs: 1000 } }, B: { status: "pending" } };
  const definitions = [{ id: "A", mode: "implementation", dependencies: [] }, { id: "B", mode: "implementation", dependencies: ["A"] }]; const output = await statusOf(fixture(tickets, definitions));
  assert.equal(output.details.metrics.wallTimeMs, null); assert.equal(output.details.metrics.workerTimeMs, null); assert.equal(output.details.metrics.utilization, null); assert.equal(output.details.metrics.criticalPath.durationMs, null);
  assert.deepEqual(output.details.metrics.incomplete, { wallTime: true, workerTime: true, utilization: true, criticalPath: true });
  assert.deepEqual(output.details.metrics.missingTiming, { wall: ["B"], worker: ["B"], criticalPath: ["B"] });
  assert.equal(output.details.nextAction, "Integrate exact validated patches for A, then call delivery_continue.");
});

test("status gives exact cleanup, active, retained, pending, and complete actions", async () => {
  for (const [tickets, expected] of [
    [{ B: { status: "integrated" }, A: { status: "disposed", disposition: "approve" } }, "Run delivery_cleanup for: A, B."],
    [{ B: { status: "running" }, A: { status: "running" } }, "Inspect active Herdr agents for: A, B."],
    [{ B: { status: "failed" }, A: { status: "blocked" } }, "Inspect retained evidence and resources for: A, B."],
    [{ B: { status: "pending" }, A: { status: "pending" } }, "Wait for scheduler readiness for: A, B."],
    [{ A: { status: "cleaned" } }, "No action; run lifecycle is complete."],
  ]) assert.equal((await statusOf(fixture(tickets))).details.nextAction, expected);
});
