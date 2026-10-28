import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { remainingOperationTimeout, runValidation, waitForAgentDeadline } from "../extensions/delivery-workflow-core.mjs";

test("startup operation uses only remaining ticket deadline and public ceiling", () => {
  assert.equal(remainingOperationTimeout(60_000, 10_000), 50_000); assert.equal(remainingOperationTimeout(500_000, 10_000), 300_000); assert.equal(remainingOperationTimeout(10_000, 10_001), 0);
});

test("wait slices remaining ticket deadline and reconciles live state", async () => {
  let clock = 0; let gets = 0; const waits = [];
  const herdr = {
    async agentWait({ timeout }) { waits.push(timeout); clock += timeout; throw new Error("public wait expired"); },
    async agentGet() { gets += 1; return { agent: { agent_status: gets === 1 ? "working" : "done" } }; },
  };
  const result = await waitForAgentDeadline(herdr, "worker", 550_000, () => clock);
  assert.deepEqual(waits, [300_000, 250_000]);
  assert.equal(result.status, "done");
  assert.equal(result.timedOut, false);
  assert.equal(result.deadlineMs, 550_000);
  assert.equal(result.elapsedMs, 550_000);
});

test("deadline retains active agent without interrupt or replacement", async () => {
  let clock = 0; const calls = [];
  const herdr = {
    async agentWait({ timeout }) { calls.push(["wait", timeout]); clock += timeout; throw new Error("public wait expired"); },
    async agentGet() { calls.push(["get"]); return { agent: { agent_status: "working" } }; },
  };
  const result = await waitForAgentDeadline(herdr, "worker", 60_000, () => clock);
  assert.deepEqual(calls, [["wait", 60_000], ["get"]]);
  assert.deepEqual(result, { timedOut: true, deadlineMs: 60_000, elapsedMs: 60_000 });
});

test("validation has explicit timeout and elapsed evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-validation-"));
  const result = await runValidation({ executable: process.execPath, args: ["-e", "setTimeout(() => {}, 1000)"] }, root, 30);
  assert.equal(result.passed, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutMs, 30);
  assert.ok(result.elapsedMs >= 20);
});

test("validation timeout terminates descendant process group", { skip: process.platform === "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-validation-tree-")); const pidFile = path.join(root, "child.pid");
  const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:['ignore','inherit','inherit']});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`;
  const started = Date.now(); const result = await runValidation({ executable: process.execPath, args: ["-e", script] }, root, 40);
  assert.equal(result.timedOut, true); assert.ok(Date.now() - started < 1500); const childPid = Number(fs.readFileSync(pidFile, "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 50)); assert.throws(() => process.kill(childPid, 0), (error) => error?.code === "ESRCH");
});

test("validation output overflow escalates and settles with bounded output", { skip: process.platform === "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-validation-output-"));
  const script = `process.on('SIGTERM',()=>{});const block='x'.repeat(65536);setInterval(()=>process.stdout.write(block),0)`;
  const started = Date.now(); const result = await runValidation({ executable: process.execPath, args: ["-e", script] }, root, 10_000);
  assert.equal(result.passed, false); assert.equal(result.outputExceeded, true); assert.equal(result.timedOut, false); assert.ok(Buffer.byteLength(result.stdout) <= 2 * 1024 * 1024); assert.ok(Date.now() - started < 1500);
});

test("validation settles when escaped descendant keeps inherited output pipe open", { skip: process.platform === "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-validation-escaped-")); const pidFile = path.join(root, "escaped.pid");
  const childScript = `process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
  const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{detached:true,stdio:['ignore','inherit','inherit']});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`;
  let escapedPid;
  try {
    const started = Date.now(); const result = await runValidation({ executable: process.execPath, args: ["-e", script] }, root, 40); escapedPid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.equal(result.timedOut, true); assert.equal(result.passed, false); assert.ok(Date.now() - started < 1500); assert.doesNotThrow(() => process.kill(escapedPid, 0));
  } finally { if (escapedPid) { try { process.kill(-escapedPid, "SIGKILL"); } catch {} } }
});

test("validation rejects unsafe timeout and argv inputs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-validation-input-"));
  assert.throws(() => runValidation({ executable: process.execPath, args: [] }, root, 0), /positive safe integer/);
  assert.throws(() => runValidation({ executable: process.execPath, args: [1] }, root, 100), /executable and args/);
});
