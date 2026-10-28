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
      async workspaceList() { return { workspaces: [{ workspace_id: "w1", worktree: { checkout_path: path.join(f.worktreeRoot, "safe-run-T1") } }] }; },
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

test("post-create verification blocks returned symlink alias before agent start", async () => {
  const f = fixture(); const expected = path.join(f.worktreeRoot, "safe-run-T1"); const alias = `${expected}-alias`; let agentStarted = false;
  try {
    const output = await withHerdr(() => createDeliveryWorkflowCore({ herdr: herdr({
      async worktreeCreate({ path: worktreePath }) { execFileSync("git", ["worktree", "add", "--detach", worktreePath, f.baseSha], { cwd: f.root }); fs.symlinkSync(worktreePath, alias); return { path: alias, pane: "w1:p1", workspace: "w1" }; },
      async workspaceList() { return { workspaces: [{ workspace_id: "w1", worktree: { checkout_path: expected } }] }; },
      async agentStart() { agentStarted = true; assert.fail("returned path alias must block before agent start"); },
      async worktreeRemove() { assert.fail("aliased resource must be retained"); },
    }) }).start(f.root, input(f)));
    assert.equal(agentStarted, false); assert.match(output.details.tickets.T1.reason, /contradictory worktree path; inspect and retain/);
    assert.equal(output.details.tickets.T1.returnedWorktreePath, alias);
  } finally { fs.rmSync(alias, { force: true }); cleanup(f); }
});

test("post-create verification blocks returned-path contradiction without removal", async () => {
  const f = fixture(); const other = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-launch-other-"));
  try {
    const output = await withHerdr(() => createDeliveryWorkflowCore({ herdr: herdr({
      async worktreeCreate({ path: worktreePath }) { execFileSync("git", ["worktree", "add", "--detach", worktreePath, f.baseSha], { cwd: f.root }); return { path: other, pane: "w1:p1", workspace: "w1" }; },
      async workspaceList() { return { workspaces: [{ workspace_id: "w1", worktree: { checkout_path: path.join(f.worktreeRoot, "safe-run-T1") } }] }; },
      async worktreeRemove() { assert.fail("contradictory resource must be retained"); },
    }) }).start(f.root, input(f)));
    assert.match(output.details.tickets.T1.reason, /contradictory worktree path; inspect and retain/);
    assert.equal(output.details.tickets.T1.returnedWorktreePath, other);
  } finally { fs.rmSync(other, { recursive: true, force: true }); cleanup(f); }
});

test("post-create workspace proof must be unique, well-formed, matching, and canonical before agent start", async () => {
  for (const contradiction of ["missing", "duplicate", "malformed", "option-workspace", "nul-workspace", "option-pane", "nul-pane", "mismatch", "noncanonical"]) {
    const f = fixture(); let agentStarted = false; const expected = path.join(f.worktreeRoot, "safe-run-T1"); const other = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-launch-live-other-")); const alias = `${expected}-alias`;
    try {
      const output = await withHerdr(() => createDeliveryWorkflowCore({ herdr: herdr({
        async worktreeCreate({ path: worktreePath }) {
          execFileSync("git", ["worktree", "add", "--detach", worktreePath, f.baseSha], { cwd: f.root });
          return {
            path: worktreePath,
            pane: contradiction === "option-pane" ? "--pane" : contradiction === "nul-pane" ? "w1:\0p1" : "w1:p1",
            workspace: contradiction === "malformed" ? " w1" : contradiction === "option-workspace" ? "--workspace" : contradiction === "nul-workspace" ? "w\u00001" : "w1",
          };
        },
        async workspaceList() {
          if (contradiction === "missing") return { workspaces: [] };
          if (contradiction === "duplicate") return { workspaces: [{ workspace_id: "w1", worktree: { checkout_path: expected } }, { workspace_id: "w1", worktree: { checkout_path: expected } }] };
          if (contradiction === "malformed") return { workspaces: [{ workspace_id: " w1", worktree: { checkout_path: expected } }] };
          if (contradiction === "option-workspace") return { workspaces: [{ workspace_id: "--workspace", worktree: { checkout_path: expected } }] };
          if (contradiction === "nul-workspace") return { workspaces: [{ workspace_id: "w\u00001", worktree: { checkout_path: expected } }] };
          if (["option-pane", "nul-pane"].includes(contradiction)) return { workspaces: [{ workspace_id: "w1", worktree: { checkout_path: expected } }] };
          if (contradiction === "mismatch") return { workspaces: [{ workspace_id: "w1", worktree: { checkout_path: other } }] };
          fs.symlinkSync(expected, alias); return { workspaces: [{ workspace_id: "w1", worktree: { checkout_path: alias } }] };
        },
        async agentStart() { agentStarted = true; assert.fail("workspace contradiction must block before agent start"); },
        async worktreeRemove() { assert.fail("created contradictory resource must be retained"); },
      }) }).start(f.root, input(f)));
      assert.equal(agentStarted, false);
      assert.match(output.details.tickets.T1.reason, contradiction === "mismatch" || contradiction === "noncanonical" ? /contradicts created worktree/ : ["missing", "duplicate"].includes(contradiction) ? /exactly one well-formed matching workspace/ : /unexpected worktree, pane, or workspace/);
    } finally { fs.rmSync(alias, { force: true }); fs.rmSync(other, { recursive: true, force: true }); cleanup(f); }
  }
});

test("cleanup retains duplicate workspace identities without removal", async () => {
  const f = fixture(); const directory = path.join(f.root, ".scratch", "delivery", "safe-run"); const worktreePath = path.join(f.worktreeRoot, "safe-run-R1");
  execFileSync("git", ["worktree", "add", "--detach", worktreePath, f.baseSha], { cwd: f.root });
  const worktreeHead = git(worktreePath, "rev-parse", "HEAD"); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "run.json"), `${JSON.stringify({ version: 2, ...input(f), tickets: [] }, null, 2)}\n`);
  fs.writeFileSync(path.join(directory, "status.json"), `${JSON.stringify({ version: 2, runId: "safe-run", phase: "awaiting_cleanup", tickets: { R1: { status: "disposed", disposition: "approve", workspace: "w1", worktreePath, reviewEvidence: { before: { worktree: { head: worktreeHead } }, parentUnchanged: true, worktreeUnchanged: true } } } }, null, 2)}\n`);
  const before = fs.readFileSync(path.join(directory, "status.json")); let removed = false;
  try {
    const output = await createDeliveryWorkflowCore({ herdr: herdr({
      async workspaceList() { return { workspaces: [{ workspace_id: "w1", agent_status: "idle", worktree: { checkout_path: worktreePath } }, { workspace_id: "w1", agent_status: "idle", worktree: { checkout_path: worktreePath } }] }; },
      async worktreeRemove() { removed = true; assert.fail("duplicate identity must retain workspace"); },
    }) }).cleanup(f.root, { runId: "safe-run" });
    assert.equal(removed, false); assert.deepEqual(output.details.cleaned, []); assert.match(output.details.retained[0].reason, /exactly one well-formed matching workspace/);
    const after = JSON.parse(fs.readFileSync(path.join(directory, "status.json"))); const original = JSON.parse(before); assert.equal(after.tickets.R1.status, original.tickets.R1.status);
  } finally { cleanup(f); }
});

test("reconcile rejects coordinated persisted run identity corruption without changing evidence", async () => {
  const f = fixture(); const directory = path.join(f.root, ".scratch", "delivery", "safe-run"); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "run.json"), `${JSON.stringify({ version: 2, ...input(f), runId: "other-run" }, null, 2)}\n`);
  fs.writeFileSync(path.join(directory, "status.json"), `${JSON.stringify({ version: 2, runId: "other-run", phase: "blocked", tickets: {} }, null, 2)}\n`);
  const beforeRun = fs.readFileSync(path.join(directory, "run.json")); const beforeStatus = fs.readFileSync(path.join(directory, "status.json")); let listed = false;
  try {
    const output = await createDeliveryWorkflowCore({ herdr: herdr({ async workspaceList() { listed = true; return { workspaces: [] }; } }) }).reconcile(f.root, { runId: "safe-run" });
    assert.equal(output.isError, true); assert.equal(listed, false); assert.deepEqual(output.details.safeActions, ["inspect_and_retain"]); assert.match(output.content[0].text, /run identity/i);
    assert.deepEqual(fs.readFileSync(path.join(directory, "run.json")), beforeRun); assert.deepEqual(fs.readFileSync(path.join(directory, "status.json")), beforeStatus);
  } finally { cleanup(f); }
});

for (const operation of ["continue", "dispose", "cleanup"]) test(`${operation} rejects coordinated persisted run identity corruption without changing evidence or Herdr`, async () => {
  const f = fixture(); const directory = path.join(f.root, ".scratch", "delivery", "safe-run"); fs.mkdirSync(directory, { recursive: true });
  const run = { version: 2, ...input(f), runId: "other-run", tickets: [{ ...input(f).tickets[0], id: "R1", mode: "review", ownedPaths: [], readPaths: ["spec.md"] }] };
  const state = { version: 2, runId: "other-run", baseSha: f.baseSha, phase: operation === "continue" ? "awaiting_integration" : operation === "dispose" ? "awaiting_disposition" : "awaiting_cleanup", tickets: { R1: { status: operation === "continue" ? "validation_passed" : operation === "dispose" ? "reviewed" : "disposed", disposition: operation === "cleanup" ? "approve" : undefined } } };
  fs.writeFileSync(path.join(directory, "run.json"), `${JSON.stringify(run, null, 2)}\n`); fs.writeFileSync(path.join(directory, "status.json"), `${JSON.stringify(state, null, 2)}\n`);
  const beforeRun = fs.readFileSync(path.join(directory, "run.json")); const beforeStatus = fs.readFileSync(path.join(directory, "status.json")); const calls = [];
  const herdrCalls = new Proxy({}, { get: (_, name) => async () => { calls.push(name); throw new Error(`unexpected Herdr call: ${String(name)}`); } });
  try {
    const core = createDeliveryWorkflowCore({ herdr: herdrCalls });
    const output = operation === "continue" ? await core.continue(f.root, { runId: "safe-run", integratedSha: f.baseSha }) : operation === "dispose" ? await core.dispose(f.root, { runId: "safe-run", ticketId: "R1", disposition: "approve" }) : await core.cleanup(f.root, { runId: "safe-run" });
    assert.equal(output.isError, true); assert.equal(output.details.status, "blocked"); assert.deepEqual(output.details.safeActions, ["inspect_and_retain"]); assert.match(output.content[0].text, /run identity/i); assert.deepEqual(calls, []);
    assert.deepEqual(fs.readFileSync(path.join(directory, "run.json")), beforeRun); assert.deepEqual(fs.readFileSync(path.join(directory, "status.json")), beforeStatus);
  } finally { cleanup(f); }
});

test("continue validates persisted root and every recorded worktree path before mutating state", async () => {
  for (const invalid of ["root", "candidate", "pending"]) {
    const f = fixture(); const directory = path.join(f.root, ".scratch", "delivery", "safe-run"); fs.mkdirSync(directory, { recursive: true });
    const run = { version: 2, ...input(f) }; const candidate = { status: "validation_passed", worktreePath: invalid === "candidate" ? f.root : path.join(f.worktreeRoot, "safe-run-T1") };
    const tickets = { T1: candidate, ...(invalid === "pending" ? { T2: { status: "pending", worktreePath: f.root } } : {}) };
    fs.writeFileSync(path.join(directory, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
    fs.writeFileSync(path.join(directory, "status.json"), `${JSON.stringify({ version: 2, runId: "safe-run", baseSha: f.baseSha, phase: "awaiting_integration", tickets }, null, 2)}\n`);
    fs.writeFileSync(path.join(f.root, "integrated.txt"), "integrated\n"); execFileSync("git", ["add", "."], { cwd: f.root }); execFileSync("git", ["commit", "-qm", "integrated"], { cwd: f.root }); const integratedSha = git(f.root, "rev-parse", "HEAD");
    if (invalid === "root") fs.rmSync(f.worktreeRoot, { recursive: true, force: true });
    const beforeRun = fs.readFileSync(path.join(directory, "run.json")); const beforeStatus = fs.readFileSync(path.join(directory, "status.json"));
    try {
      const output = await createDeliveryWorkflowCore({ herdr: herdr() }).continue(f.root, { runId: "safe-run", integratedSha });
      assert.equal(output.isError, true); assert.equal(output.details.status, "blocked");
      assert.match(output.content[0].text, invalid === "root" ? /worktreeRoot/ : /worktree path/);
      assert.deepEqual(fs.readFileSync(path.join(directory, "run.json")), beforeRun); assert.deepEqual(fs.readFileSync(path.join(directory, "status.json")), beforeStatus);
    } finally { cleanup(f); }
  }
});

test("approve disposition validates review and pending downstream paths before mutating reviewed state", async () => {
  for (const invalidTicket of ["root", "R1", "T1"]) {
    const f = fixture(); const directory = path.join(f.root, ".scratch", "delivery", "safe-run"); fs.mkdirSync(directory, { recursive: true });
    const run = { version: 2, ...input(f), tickets: [
      { ...input(f).tickets[0], id: "R1", mode: "review", ownedPaths: [], readPaths: ["spec.md"], worker: { ...input(f).tickets[0].worker, name: "reviewer" } },
      { ...input(f).tickets[0], dependencies: ["R1"] },
    ] };
    const recorded = (ticketId) => invalidTicket === ticketId ? f.root : path.join(f.worktreeRoot, `safe-run-${ticketId}`);
    const state = { version: 2, runId: "safe-run", baseSha: f.baseSha, phase: "awaiting_disposition", tickets: {
      R1: { status: "reviewed", verdict: "approve", worktreePath: recorded("R1"), reviewEvidence: { parentUnchanged: true, worktreeUnchanged: true } },
      T1: { status: "pending", worktreePath: recorded("T1") },
    } };
    fs.writeFileSync(path.join(directory, "run.json"), `${JSON.stringify(run, null, 2)}\n`); fs.writeFileSync(path.join(directory, "status.json"), `${JSON.stringify(state, null, 2)}\n`);
    if (invalidTicket === "root") fs.rmSync(f.worktreeRoot, { recursive: true, force: true });
    const before = fs.readFileSync(path.join(directory, "status.json"));
    try {
      const output = await createDeliveryWorkflowCore({ herdr: herdr() }).dispose(f.root, { runId: "safe-run", ticketId: "R1", disposition: "approve" });
      assert.equal(output.isError, true); assert.equal(output.details.status, "blocked"); assert.match(output.content[0].text, invalidTicket === "root" ? /worktreeRoot/ : /worktree path/);
      assert.deepEqual(fs.readFileSync(path.join(directory, "status.json")), before);
    } finally { cleanup(f); }
  }
});

test("approve disposition with zero pending tickets validates root and review path before byte-equivalent failure", async () => {
  for (const invalid of ["root", "review"]) {
    const f = fixture(); const directory = path.join(f.root, ".scratch", "delivery", "safe-run"); fs.mkdirSync(directory, { recursive: true });
    const run = { version: 2, ...input(f), tickets: [
      { ...input(f).tickets[0], id: "R1", mode: "review", ownedPaths: [], readPaths: ["spec.md"], worker: { ...input(f).tickets[0].worker, name: "reviewer" } },
    ] };
    const state = { version: 2, runId: "safe-run", baseSha: f.baseSha, phase: "awaiting_disposition", tickets: {
      R1: { status: "reviewed", verdict: "approve", worktreePath: invalid === "review" ? f.root : path.join(f.worktreeRoot, "safe-run-R1"), reviewEvidence: { parentUnchanged: true, worktreeUnchanged: true } },
    } };
    fs.writeFileSync(path.join(directory, "run.json"), `${JSON.stringify(run, null, 2)}\n`); fs.writeFileSync(path.join(directory, "status.json"), `${JSON.stringify(state, null, 2)}\n`);
    if (invalid === "root") fs.rmSync(f.worktreeRoot, { recursive: true, force: true });
    const beforeRun = fs.readFileSync(path.join(directory, "run.json")); const beforeStatus = fs.readFileSync(path.join(directory, "status.json"));
    try {
      const output = await createDeliveryWorkflowCore({ herdr: herdr() }).dispose(f.root, { runId: "safe-run", ticketId: "R1", disposition: "approve" });
      assert.equal(output.isError, true); assert.equal(output.details.status, "blocked"); assert.deepEqual(output.details.safeActions, ["inspect_and_retain"]); assert.match(output.content[0].text, invalid === "root" ? /worktreeRoot/ : /worktree path/);
      assert.deepEqual(fs.readFileSync(path.join(directory, "run.json")), beforeRun); assert.deepEqual(fs.readFileSync(path.join(directory, "status.json")), beforeStatus);
    } finally { cleanup(f); }
  }
});

test("reconcile blocks recorded paths outside root or unequal to exact expected child without persistence mutation", async () => {
  for (const invalid of ["outside", "wrong-child"]) {
    const f = fixture(); const directory = path.join(f.root, ".scratch", "delivery", "legacy-run"); fs.mkdirSync(directory, { recursive: true });
    const recordedPath = invalid === "outside" ? f.root : path.join(f.worktreeRoot, "legacy-run-other");
    fs.writeFileSync(path.join(directory, "run.json"), JSON.stringify({ version: 2, runId: "legacy-run", baseSha: f.baseSha, worktreeRoot: f.worktreeRoot, tickets: [] }));
    fs.writeFileSync(path.join(directory, "status.json"), JSON.stringify({ version: 2, runId: "legacy-run", baseSha: f.baseSha, phase: "blocked", tickets: { T1: { status: "blocked", workspace: "w1", worktreePath: recordedPath } } }));
    const beforeRun = fs.readFileSync(path.join(directory, "run.json")); const beforeStatus = fs.readFileSync(path.join(directory, "status.json"));
    try {
      const output = await createDeliveryWorkflowCore({ herdr: herdr({ async workspaceList() { return { workspaces: [] }; } }) }).reconcile(f.root, { runId: "legacy-run" });
      assert.equal(output.isError, true); assert.deepEqual(output.details.safeActions, ["inspect_and_retain"]); assert.match(output.content[0].text, invalid === "outside" ? /not an exact child/ : /does not match exact ticket evidence/);
      assert.deepEqual(fs.readFileSync(path.join(directory, "run.json")), beforeRun); assert.deepEqual(fs.readFileSync(path.join(directory, "status.json")), beforeStatus);
    } finally { cleanup(f); }
  }
});
