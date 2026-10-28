import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createDeliveryWorkflowCore } from "../extensions/delivery-workflow-core.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-launch-safe-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  fs.writeFileSync(path.join(root, ".gitignore"), ".scratch/\n");
  fs.writeFileSync(path.join(root, "spec.md"), "spec\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
  return { root: fs.realpathSync(root), baseSha: git(root, "rev-parse", "HEAD"), worktreeRoot: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delivery-launch-safe-trees-"))) };
}
function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function input(fixture) {
  return { runId: "safe-run", objective: "Safe launch", baseSha: fixture.baseSha, worktreeRoot: fixture.worktreeRoot, tickets: [{ id: "T1", goal: "Test", definitionOfDone: "Done", dependencies: [], ownedPaths: ["a.txt"], worker: { name: "worker", kind: "worker", model: "9router/cx/gpt-5.6-sol", thinking: "medium", tools: ["read"] }, validation: { executable: "true", args: [] }, specPaths: ["spec.md"] }] };
}
function herdr(overrides = {}) {
  return { async status() {}, async integrationStatus() { return [{ name: "pi", status: "current (v1)" }]; }, async notify() {}, ...overrides };
}
async function withHerdr(callback) {
  const previous = process.env.HERDR_ENV; process.env.HERDR_ENV = "1";
  try { return await callback(); } finally { if (previous === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previous; }
}
function cleanup(fixture) { fs.rmSync(fixture.root, { recursive: true, force: true }); fs.rmSync(fixture.worktreeRoot, { recursive: true, force: true }); }

test("persists canonical root provenance before launch and rejects preexisting child", async () => {
  const f = fixture(); const child = path.join(f.worktreeRoot, "safe-run-T1"); fs.mkdirSync(child); let launched = false;
  try {
    const output = await withHerdr(() => createDeliveryWorkflowCore({ herdr: herdr({
      async worktreeCreate() { launched = true; assert.fail("preexisting child must block before Herdr launch"); },
    }) }).start(f.root, input(f)));
    const saved = JSON.parse(fs.readFileSync(path.join(f.root, ".scratch", "delivery", "safe-run", "run.json")));
    assert.equal(saved.worktreeRoot, f.worktreeRoot); assert.equal(saved.worktreeRootProvenance, "override");
    assert.equal(launched, false); assert.match(output.details.tickets.T1.reason, /already exists; inspect and retain/);
  } finally { cleanup(f); }
});

test("broken child symlink blocks before Herdr launch", async () => {
  const f = fixture(); const child = path.join(f.worktreeRoot, "safe-run-T1"); fs.symlinkSync(path.join(f.worktreeRoot, "missing-target"), child); let launched = false;
  try {
    const output = await withHerdr(() => createDeliveryWorkflowCore({ herdr: herdr({
      async worktreeCreate() { launched = true; assert.fail("broken symlink must block before Herdr launch"); },
      async worktreeRemove() { assert.fail("preexisting unknown resource must be retained"); },
    }) }).start(f.root, input(f)));
    assert.equal(launched, false); assert.match(output.details.tickets.T1.reason, /already exists; inspect and retain/);
  } finally { cleanup(f); }
});

test("root swap during create blocks and retains returned workspace", async () => {
  const f = fixture(); const original = `${f.worktreeRoot}-original`; let removed = false;
  try {
    const output = await withHerdr(() => createDeliveryWorkflowCore({ herdr: herdr({
      async worktreeCreate({ path: worktreePath }) {
        fs.renameSync(f.worktreeRoot, original); fs.mkdirSync(f.worktreeRoot, { mode: 0o700 });
        return { path: worktreePath, pane: "w1:p1", workspace: "w1" };
      },
      async worktreeRemove() { removed = true; },
    }) }).start(f.root, input(f)));
    assert.equal(removed, false); assert.match(output.details.tickets.T1.reason, /identity changed during creation; inspect and retain/);
    assert.equal(output.details.tickets.T1.workspace, "w1");
  } finally { fs.rmSync(original, { recursive: true, force: true }); cleanup(f); }
});

test("post-create verification blocks wrong Git base and retains exact evidence", async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.root, "later.txt"), "later\n"); execFileSync("git", ["add", "."], { cwd: f.root }); execFileSync("git", ["commit", "-qm", "later"], { cwd: f.root }); const latest = git(f.root, "rev-parse", "HEAD");
  try {
    const output = await withHerdr(() => createDeliveryWorkflowCore({ herdr: herdr({
      async worktreeCreate({ path: worktreePath }) { execFileSync("git", ["worktree", "add", "--detach", worktreePath, latest], { cwd: f.root }); return { path: worktreePath, pane: "w1:p1", workspace: "w1" }; },
      async workspaceList() { return { workspaces: [{ workspace_id: "w1", worktree: { checkout_path: path.join(f.worktreeRoot, "safe-run-T1") } }] }; },
      async worktreeRemove() { assert.fail("contradictory resource must be retained"); },
    }) }).start(f.root, input(f)));
    assert.match(output.details.tickets.T1.reason, /Git identity or base SHA is contradictory/);
    assert.equal(output.details.tickets.T1.workspace, "w1"); assert.equal(output.details.tickets.T1.worktreePath, path.join(f.worktreeRoot, "safe-run-T1"));
  } finally { cleanup(f); }
});

test("post-create verification blocks returned-path contradiction without removal", async () => {
  const f = fixture(); const other = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-launch-other-"));
  try {
    const output = await withHerdr(() => createDeliveryWorkflowCore({ herdr: herdr({
      async worktreeCreate({ path: worktreePath }) { execFileSync("git", ["worktree", "add", "--detach", worktreePath, f.baseSha], { cwd: f.root }); return { path: other, pane: "w1:p1", workspace: "w1" }; },
      async worktreeRemove() { assert.fail("contradictory resource must be retained"); },
    }) }).start(f.root, input(f)));
    assert.match(output.details.tickets.T1.reason, /contradictory worktree path; inspect and retain/);
    assert.equal(output.details.tickets.T1.returnedWorktreePath, other);
  } finally { fs.rmSync(other, { recursive: true, force: true }); cleanup(f); }
});

test("reconcile accepts legacy persisted root and blocks recorded path outside it", async () => {
  const f = fixture(); const directory = path.join(f.root, ".scratch", "delivery", "legacy-run"); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "run.json"), JSON.stringify({ version: 2, runId: "legacy-run", baseSha: f.baseSha, worktreeRoot: f.worktreeRoot, tickets: [] }));
  fs.writeFileSync(path.join(directory, "status.json"), JSON.stringify({ version: 2, runId: "legacy-run", baseSha: f.baseSha, phase: "blocked", tickets: { T1: { status: "blocked", workspace: "w1", worktreePath: f.root } } }));
  try {
    const output = await createDeliveryWorkflowCore({ herdr: herdr({ async workspaceList() { return { workspaces: [] }; } }) }).reconcile(f.root, { runId: "legacy-run" });
    assert.equal(output.isError, true); assert.deepEqual(output.details.safeActions, ["inspect_and_retain"]); assert.match(output.content[0].text, /not an exact child/);
  } finally { cleanup(f); }
});
