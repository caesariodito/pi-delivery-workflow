import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openExecutionStore } from "../extensions/lib/execution-store.mjs";
function fixture(t) { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "execution-store-"))); fs.chmodSync(root, 0o700); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }

test("exclusive controller ownership blocks duplicates and stale lock guessing", t => {
  const root = fixture(t); const first = openExecutionStore(root); const second = openExecutionStore(root);
  assert.throws(() => first.begin("launch", {}), /lock/);
  first.acquire(); assert.throws(() => second.acquire(), /EEXIST/);
  assert.equal(second.lockInfo().pid, process.pid); first.release(); second.acquire(); second.release();
});

test("intent without outcome is unknown and never authorizes replay", t => {
  const root = fixture(t); const store = openExecutionStore(root); store.acquire();
  store.begin("launch-1", { actor: "writer", candidate: "abc" });
  assert.equal(store.inspect("launch-1").status, "recovery_unknown"); assert.equal(store.inspect("launch-1").replayAllowed, false);
  assert.throws(() => store.begin("launch-1", {}), /EEXIST/);
  store.settle("launch-1", { workspace: "w1", pane: "p1" });
  assert.equal(store.inspect("launch-1").status, "recorded"); assert.throws(() => store.settle("launch-1", {}), /EEXIST/);
  store.release();
});

test("outcome binds immutable intent; snapshots preserve original counters", t => {
  const root = fixture(t); const store = openExecutionStore(root); store.acquire(); store.begin("check-1", { command: "node" }); store.settle("check-1", { passed: true });
  store.saveState({ deadlineAt: 123, actorLaunches: 4 }); assert.deepEqual(store.state(), { deadlineAt: 123, actorLaunches: 4 });
  fs.writeFileSync(path.join(root, "check-1.intent.json"), JSON.stringify({ version: 1, operationId: "check-1", intent: { command: "changed" } }));
  assert.throws(() => store.inspect("check-1"), /mismatch/); store.release();
});

test("store rejects symlinked evidence and operation path escapes", t => {
  const root = fixture(t); const store = openExecutionStore(root); store.acquire();
  assert.throws(() => store.begin("../escape", {}), /ID/);
  fs.writeFileSync(path.join(root, "target.json"), "{}"); fs.symlinkSync("target.json", path.join(root, "state.json")); assert.throws(() => store.state());
  store.release();
});
