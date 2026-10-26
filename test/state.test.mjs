import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireRunnerLock, appendJsonLine, atomicWriteJson, readJson, releaseRunnerLock, writeInboxRequest, writeReceipt } from "../extensions/lib/state.mjs";

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "delivery-state-"));
}

const owner = { version: 1, pid: 123, ownershipToken: "1111111111111111111111111111111111111111111111111111111111111111", runId: "run-1", createdAt: "2026-01-01T00:00:00.000Z" };

test("writes atomic JSON and append-only JSON lines", () => {
  const root = temporaryDirectory();
  const state = path.join(root, "nested/state.json");
  atomicWriteJson(state, { status: "ready" });
  assert.deepEqual(readJson(state), { status: "ready" });
  assert.equal(fs.statSync(state).mode & 0o777, 0o600);
  const journal = path.join(root, "journal.jsonl");
  appendJsonLine(journal, { from: "ready", to: "allocating" });
  appendJsonLine(journal, { from: "allocating", to: "active" });
  assert.equal(fs.readFileSync(journal, "utf8").trim().split("\n").length, 2);
  for (const invalid of [undefined, { value: undefined }, { value: Number.NaN }, { value: 1n }]) {
    assert.throws(() => atomicWriteJson(path.join(root, "invalid.json"), invalid), /JSON-serializable/);
  }
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => atomicWriteJson(path.join(root, "cyclic.json"), cyclic), /JSON-serializable/);
});

test("runner lock uses exclusive creation and fail-closed stale checks", () => {
  const root = temporaryDirectory();
  const lock = path.join(root, "runner.lock");
  assert.deepEqual(acquireRunnerLock(lock, owner), owner);
  assert.throws(() => acquireRunnerLock(lock, { ...owner, pid: 456 }), /unknown/);
  assert.throws(() => acquireRunnerLock(lock, { ...owner, pid: 456 }, { isOwnerAlive: () => undefined }), /alive or unknown/);
  assert.throws(() => releaseRunnerLock(lock, { ...owner, ownershipToken: "9999999999999999999999999999999999999999999999999999999999999999" }), /does not match/);
  releaseRunnerLock(lock, owner);
  assert.equal(fs.existsSync(lock), false);
});

test("demonstrably stale lock can be replaced and stale evidence remains", () => {
  const root = temporaryDirectory();
  const lock = path.join(root, "runner.lock");
  acquireRunnerLock(lock, owner);
  const next = { ...owner, pid: 456, ownershipToken: "2222222222222222222222222222222222222222222222222222222222222222", runId: "run-2" };
  assert.deepEqual(acquireRunnerLock(lock, next, { isOwnerAlive: (record) => record.pid === 123 ? false : true }), next);
  assert.ok(fs.readdirSync(root).some((name) => name.startsWith("runner.lock.stale-")));
});

test("stale takeover never restores over a concurrently published live lock", () => {
  const root = temporaryDirectory();
  const lock = path.join(root, "runner.lock");
  acquireRunnerLock(lock, owner);
  const live = { ...owner, pid: 789, ownershipToken: "3333333333333333333333333333333333333333333333333333333333333333", runId: "run-live" };
  const originalLink = fs.linkSync;
  fs.linkSync = (temporary, destination) => {
    if (destination === lock && !fs.existsSync(lock)) fs.writeFileSync(lock, `${JSON.stringify(live)}\n`, { mode: 0o600 });
    return originalLink(temporary, destination);
  };
  try {
    assert.throws(() => acquireRunnerLock(lock, { ...owner, pid: 456, ownershipToken: "2222222222222222222222222222222222222222222222222222222222222222", runId: "run-2" }, { isOwnerAlive: () => false }), { code: "EEXIST" });
  } finally {
    fs.linkSync = originalLink;
  }
  assert.deepEqual(readJson(lock), live);
  assert.ok(fs.readdirSync(root).some((name) => name.startsWith("runner.lock.stale-")));
});

test("inbox and receipts publish complete exclusive files", () => {
  const root = temporaryDirectory();
  const request = { version: 1, requestId: "request-1", runId: "run-1", action: "status", createdAt: "2026-01-01T00:00:00.000Z" };
  const inbox = path.join(root, "inbox");
  const finalPath = path.join(inbox, "request-1.json");
  const originalLink = fs.linkSync;
  fs.linkSync = (temporary, destination) => {
    assert.equal(destination, finalPath);
    assert.equal(fs.existsSync(destination), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(temporary, "utf8")), request);
    return originalLink(temporary, destination);
  };
  try {
    writeInboxRequest(inbox, request);
  } finally {
    fs.linkSync = originalLink;
  }
  assert.deepEqual(readJson(path.join(root, "inbox/request-1.json")), request);
  assert.throws(() => writeInboxRequest(inbox, request), { code: "EEXIST" });
  assert.equal(fs.readdirSync(inbox).some((name) => name.startsWith(".")), false);
  writeReceipt(path.join(root, "receipts"), { requestId: "request-1", ok: true });
  assert.deepEqual(readJson(path.join(root, "receipts/request-1.json")), { requestId: "request-1", ok: true });
  assert.throws(() => writeReceipt(path.join(root, "receipts"), { requestId: "bad/id", ok: false }), /requestId/);
});
