import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import deliveryWorkflow from "../extensions/delivery-workflow.ts";
import deliveryResultTool from "../extensions/reviewer-result-tool.ts";
import { createDeliveryWorkflowCore } from "../extensions/delivery-workflow-core.mjs";

function fakePi() { const tools = new Map(); const commands = new Map(); const flags = new Map(); return { tools, commands, flags, registerTool(tool) { tools.set(tool.name, tool); }, registerCommand(name, command) { commands.set(name, command); }, registerFlag(name) { if (!flags.has(name)) flags.set(name, undefined); }, getFlag(name) { return flags.get(name); }, sendUserMessage() {} }; }

test("registers thin supervised tool surface", () => {
  const pi = fakePi(); deliveryWorkflow(pi);
  assert.deepEqual([...pi.tools.keys()].sort(), ["delivery_continue", "delivery_start", "delivery_status", "delivery_steer", "delivery_stop"]);
  assert.equal(pi.commands.has("delivery"), true); assert.equal(pi.tools.has("delivery_recover"), false); assert.equal(pi.tools.has("delivery_reply"), false); assert.equal(pi.tools.has("delivery_review"), false);
});

test("scoped result tool writes ticket result once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-result-")); const destination = path.join(root, "result.json"); const pi = fakePi(); pi.flags.set("delivery-result-path", destination); pi.flags.set("delivery-result-nonce", "nonce"); deliveryResultTool(pi); const tool = pi.tools.get("delivery_result_write");
  await tool.execute("id", { nonce: "nonce", ticketId: "T1", status: "done", summary: "done", changedPaths: ["src/a.js"], validation: "passed", handoff: "exports A", question: null });
  assert.equal(JSON.parse(fs.readFileSync(destination)).ticketId, "T1"); assert.throws(() => fs.writeFileSync(destination, "again", { flag: "wx" }));
});

test("status and inactive controls preserve inspection-only behavior", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-core-")); const directory = path.join(root, ".scratch", "delivery", "run-1"); fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, "status.json"), JSON.stringify({ version: 1, runId: "run-1", phase: "blocked", tickets: {} }));
  const core = createDeliveryWorkflowCore({ herdr: {} }); assert.equal((await core.status(root, { runId: "run-1" })).details.phase, "blocked"); assert.equal((await core.steer(root, { runId: "run-1", ticketId: "T1", message: "x" })).details.status, "not_active");
});
