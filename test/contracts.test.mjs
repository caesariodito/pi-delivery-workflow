import assert from "node:assert/strict";
import test from "node:test";
import {
  LIFECYCLE_TRANSITIONS,
  pathsOverlap,
  validateCommandSpec,
  validateControlRequest,
  validateLifecycleTransition,
  validateOwnedPaths,
  validateRelativePath,
  validateRunId,
  validateTicketId,
} from "../extensions/lib/contracts.mjs";

test("validates bounded IDs and portable paths", () => {
  assert.equal(validateRunId("run-1.2"), "run-1.2");
  assert.equal(validateTicketId("T001"), "T001");
  for (const value of ["", "../x", "/tmp/x", "a\\b", "src//", "src///", "a//b", "a\0b"]) assert.throws(() => validateRelativePath(value));
  assert.equal(validateRelativePath("src/lib/"), "src/lib/");
});

test("models exact and directory-prefix ownership without glob guessing", () => {
  const owned = validateOwnedPaths(["src/main.mjs", "test/"]);
  assert.deepEqual(owned, [{ path: "src/main.mjs", directory: false }, { path: "test", directory: true }]);
  assert.equal(pathsOverlap("src/", "src/main.mjs"), true);
  assert.equal(pathsOverlap("src/", "src/a"), true);
  assert.equal(pathsOverlap("src/main.mjs", "src/main.mjs"), true);
  assert.equal(pathsOverlap("src", "src/main.mjs"), false);
  assert.equal(pathsOverlap("src/", "source/main.mjs"), false);
  assert.throws(() => pathsOverlap("src/**", "src/main.mjs"), /exact/);
});

test("enforces lifecycle graph", () => {
  assert.ok(Object.isFrozen(LIFECYCLE_TRANSITIONS));
  assert.equal(validateLifecycleTransition("ready", "allocating"), "allocating");
  assert.equal(validateLifecycleTransition("allocating", "active"), "active");
  assert.throws(() => validateLifecycleTransition("allocating", "setting_up"), /unknown lifecycle/);
  assert.equal(validateLifecycleTransition("review", "needs_fix"), "needs_fix");
  assert.equal(validateLifecycleTransition("done", "awaiting_integration"), "awaiting_integration");
  assert.throws(() => validateLifecycleTransition("active", "done"), /invalid lifecycle/);
  assert.throws(() => validateLifecycleTransition("blocked", "ready"), /invalid lifecycle/);
});

test("validates argv commands and control requests", () => {
  assert.deepEqual(validateCommandSpec({ executable: "node", args: ["--test", "test/x.mjs"], cwd: "repo" }), { executable: "node", args: ["--test", "test/x.mjs"], cwd: "repo" });
  assert.throws(() => validateCommandSpec({ executable: "sh", args: [], shell: true }), /only executable/);
  assert.throws(() => validateCommandSpec({ executable: "node", args: [], setup: {} }), /only executable/);
  const request = { version: 1, requestId: "request-1", runId: "run-1", action: "stop", createdAt: "2026-01-01T00:00:00.000Z" };
  assert.deepEqual(validateControlRequest(request), request);
  assert.throws(() => validateControlRequest({ ...request, action: "exec" }), /action/);
  assert.throws(() => validateControlRequest({ ...request, action: "message" }), /requires message/);
  assert.throws(() => validateControlRequest({ ...request, createdAt: "2026-01-01" }), /canonical ISO/);
  assert.throws(() => validateControlRequest({ ...request, createdAt: "2026-02-30T00:00:00.000Z" }), /canonical ISO/);
});
