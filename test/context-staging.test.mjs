import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createDeliveryWorkflowCore } from "../extensions/delivery-workflow-core.mjs";
import { previewTicketGraph, validateRunInput } from "../extensions/lib/scheduler.mjs";

async function scenario({ review = false, bytes = Buffer.from("spec\r\n\0"), files = [".scratch/delivery/contracts/spec.md"], prepare, created, started, settled, validation, setup, expectedError } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-context-"));
  const root = path.join(temporary, "repo"); const worktreeRoot = path.join(temporary, "trees");
  fs.mkdirSync(root); fs.mkdirSync(worktreeRoot);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const previous = process.env.HERDR_ENV; process.env.HERDR_ENV = "1";
  try {
    git("init", "-q"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
    fs.writeFileSync(path.join(root, ".gitignore"), ".scratch/\n"); fs.writeFileSync(path.join(root, "tracked.md"), "tracked\n");
    await setup?.({ root, git });
    git("add", "."); git("commit", "-qm", "test: fixture");
    for (const file of files) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), bytes); }
    const baseSha = git("rev-parse", "HEAD").trim();
    let tree; let starts = 0; let creates = 0;
    const ticket = { id: "T1", mode: review ? "review" : "implementation", goal: "Test", definitionOfDone: "Done", dependencies: [], ownedPaths: review ? [] : ["owned.txt"], ...(review ? { readPaths: [...new Set(files), "tracked.md"] } : {}), worker: { name: "context-worker", kind: review ? "reviewer" : "worker", model: "model", thinking: "medium", tools: ["read"] }, validation: validation ?? { executable: process.execPath, args: ["-e", ""] }, specPaths: [...files, "tracked.md"] };
    const input = { runId: "context-run", objective: "Test", baseSha, worktreeRoot, contextPaths: files, tickets: [ticket] };
    await prepare?.({ root, input, git });
    const herdr = {
      async status() {}, async integrationStatus() { return [{ name: "pi", status: "current (v1)" }]; },
      async worktreeCreate({ path: destination, base }) {
        creates++; git("worktree", "add", "--detach", destination, base); tree = fs.realpathSync(destination);
        await created?.({ root, tree, input }); return { path: destination, workspace: "w1", pane: "p1" };
      },
      async workspaceList() { return { workspaces: [{ workspace_id: "w1", worktree: { checkout_path: tree } }] }; },
      async agentStart({ agentArgs }) {
        starts++;
        for (const file of files) assert.deepEqual(fs.readFileSync(path.join(tree, file)), bytes);
        const packet = fs.readFileSync(path.join(root, ".scratch/delivery/context-run/prompts/T1.md"), "utf8");
        for (const file of new Set(files)) assert.equal(packet.split(`- \`${file}\``).length - 1, review ? 2 : 1);
        await started?.({ root, tree, input });
        const resultPath = agentArgs[agentArgs.indexOf("--delivery-result-path") + 1];
        const result = review ? { verdict: "approve", findings: [], residualRisks: [] } : { status: "done", changedPaths: [], validation: "passed", handoff: "done" };
        fs.writeFileSync(resultPath, JSON.stringify({ version: 1, ticketId: "T1", summary: "done", question: null, ...result }));
      },
      async agentGet() { return { agent: { agent_status: "done" } }; },
    };
    const core = createDeliveryWorkflowCore({ herdr });
    let output;
    try { output = await core.start(root, input); }
    catch (error) { if (!expectedError) throw error; assert.match(error.message, expectedError); output = { details: { phase: "blocked", reason: error.message, tickets: {} } }; }
    await settled?.({ root, tree, input, core, output, git });
    return { output, starts, creates, patch: fs.existsSync(path.join(root, ".scratch/delivery/context-run/patches/T1.patch")) ? fs.readFileSync(path.join(root, ".scratch/delivery/context-run/patches/T1.patch"), "utf8") : null, retained: tree && fs.existsSync(tree) };
  } finally {
    if (previous === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previous;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

test("new graph preview requires explicit review context scope; legacy normalization remains compatible", async () => {
  await scenario({ review: true, prepare({ input }) {
    input.tickets[0].readPaths = ["tracked.md"];
    const legacy = validateRunInput(input);
    assert.throws(() => previewTicketGraph(legacy), /readPaths must cover context/);
    input.tickets[0].readPaths = [".scratch/", "tracked.md"];
  } });
});
for (const review of [false, true]) test(`dirty tracked mode blocks ${review ? "review" : "worker"} without repairing checkout`, async () => {
  const result = await scenario({ review, created({ tree }) { fs.chmodSync(path.join(tree, "tracked.md"), 0o755); } });
  assert.equal(result.starts, 0); assert.match(result.output.details.tickets.T1.reason, /immutable base or clean checkout/);
});
for (const review of [false, true]) test(`clean ${review ? "review" : "worker"} accepts ignored context and deduplicates packet`, async () => {
  const result = await scenario({ review, files: [".scratch/delivery/contracts/spec.md", ".scratch/delivery/contracts/spec.md"] });
  assert.equal(result.starts, 1); assert.equal(result.output.details.tickets.T1.status, review ? "reviewed" : "validation_passed", result.output.details.tickets.T1.reason);
  if (!review) assert.equal(result.patch, "");
});
for (const size of [262144, 262145]) test(`context byte bound ${size}`, async () => {
  const result = await scenario({ bytes: Buffer.alloc(262144, 1), created({ root }) { if (size > 262144) fs.appendFileSync(path.join(root, ".scratch/delivery/contracts/spec.md"), "x"); } });
  assert.equal(result.creates, 1); assert.equal(result.starts, size <= 262144 ? 1 : 0);
  if (size > 262144) assert.match(result.output.details.tickets.T1.reason, /byte limit/);
});
for (const review of [false, true]) test(`ignored context mutation blocks ${review ? "review" : "worker"} despite clean Git status`, async () => {
  const result = await scenario({ review, started({ tree }) { fs.writeFileSync(path.join(tree, ".scratch/delivery/contracts/spec.md"), "changed"); } });
  assert.equal(result.output.details.phase, "blocked"); assert.equal(result.patch, null);
});
for (const location of ["source", "destination"]) for (const intermediate of [false, true]) test(`${location} ${intermediate ? "intermediate" : "final"} symlink blocks before launch`, async () => {
  const attack = ({ root, tree }) => {
    const base = location === "source" ? root : tree;
    const target = path.join(base, intermediate ? ".scratch/delivery/contracts" : ".scratch/delivery/contracts/spec.md");
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.rmSync(target, { recursive: true, force: true });
    const valid = path.join(root, ".scratch/valid"); fs.mkdirSync(valid, { recursive: true }); fs.writeFileSync(path.join(valid, "spec.md"), "valid");
    fs.symlinkSync(intermediate ? valid : path.join(root, "tracked.md"), target);
  };
  const result = await scenario({ created: attack });
  assert.equal(result.creates, 1); assert.equal(result.starts, 0); assert.match(result.output.details.tickets.T1.reason, /unsafe context component/);
});
for (const identical of [false, true]) test(`existing ignored destination ${identical ? "reused" : "collision blocked"}`, async () => {
  const result = await scenario({ created({ tree }) { const file = path.join(tree, ".scratch/delivery/contracts/spec.md"); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, identical ? Buffer.from("spec\r\n\0") : "different"); } });
  assert.equal(result.starts, identical ? 1 : 0);
});
test("owned patch excludes ignored context", async () => {
  const result = await scenario({ started({ tree }) { fs.writeFileSync(path.join(tree, "owned.txt"), "owned\n"); } });
  assert.equal(result.output.details.phase, "awaiting_integration"); assert.match(result.patch, /owned.txt/); assert.doesNotMatch(result.patch, /spec.md/);
});
test("parent nonignored untracked context fails explicit clean-parent preflight", async () => {
  const result = await scenario({ files: ["untracked.md"], expectedError: /parent checkout must be clean/ }); assert.equal(result.creates, 0); assert.equal(result.starts, 0);
});
test("child must independently ignore context", async () => {
  const result = await scenario({ created({ tree }) { fs.writeFileSync(path.join(tree, ".gitignore"), ""); } });
  assert.equal(result.creates, 1); assert.equal(result.starts, 0); assert.match(result.output.details.tickets.T1.reason, /check-ignore/);
});
test("current runtime evidence namespace rejected at staging seam", async () => {
  const mkdir = fs.mkdirSync;
  try {
    fs.mkdirSync = function (file, options) {
      if (String(file).endsWith("/repo/.scratch/delivery/context-run") && options?.recursive === false && fs.existsSync(file)) return;
      return mkdir.call(this, file, options);
    };
    const result = await scenario({ files: [".scratch/delivery/context-run/source.md"] });
    assert.equal(result.creates, 1); assert.equal(result.starts, 0); assert.match(result.output.details.tickets.T1.reason, /overlaps evidence/);
  } finally { fs.mkdirSync = mkdir; }
});
for (const executable of [false, true]) test(`tracked ${executable ? "100755" : "100644"} reused without inode, mode or byte changes`, async () => {
  let before;
  const result = await scenario({ setup({ root }) { if (executable) fs.chmodSync(path.join(root, "tracked.md"), 0o755); }, created({ tree }) { before = fs.statSync(path.join(tree, "tracked.md")); }, started({ tree }) {
    const after = fs.statSync(path.join(tree, "tracked.md")); assert.equal(after.ino, before.ino); assert.equal(after.mode, before.mode); assert.equal(after.mode & 0o777, executable ? 0o755 : 0o644); assert.equal(fs.readFileSync(path.join(tree, "tracked.md"), "utf8"), "tracked\n");
  } }); assert.equal(result.starts, 1);
});
test("late copy failure retains partial private context and never starts", async () => {
  const original = fs.writeFileSync;
  try {
    fs.writeFileSync = function (file, ...args) {
      if (String(file).includes("/trees/") && String(file).endsWith("second.md")) throw new Error("injected staging write failure");
      return original.call(this, file, ...args);
    };
    const result = await scenario({ files: [".scratch/first.md", ".scratch/second.md"], settled({ tree }) { assert.ok(fs.existsSync(path.join(tree, ".scratch/first.md"))); } });
    assert.equal(result.starts, 0); assert.equal(result.retained, true); assert.match(result.output.details.tickets.T1.reason, /injected staging write failure/);
  } finally { fs.writeFileSync = original; }
});
test("validation cannot mutate ignored context or request a repair afterward", async () => {
  const result = await scenario({ prepare({ input }) { input.tickets[0].maxFixRounds = 1; }, validation: { executable: process.execPath, args: ["-e", "require('fs').writeFileSync('.scratch/delivery/contracts/spec.md','changed');process.exit(1)"] } });
  assert.equal(result.output.details.phase, "blocked"); assert.equal(result.patch, null); assert.match(result.output.details.tickets.T1.reason, /staged context mutated/);
});
for (const count of [32, 33]) test(`new preview context count ${count}`, async () => {
  const result = await scenario({ prepare({ input }) {
    input.contextPaths = Array(count).fill(input.contextPaths[0]);
    const normalized = validateRunInput(input);
    if (count === 33) assert.throws(() => previewTicketGraph(normalized), /0-32/);
    else previewTicketGraph(normalized);
    input.contextPaths = [input.contextPaths[0]];
  } }); assert.equal(result.starts, 1);
});
for (const pair of [[".scratch/Case.md", ".scratch/case.md"], [".scratch/é.md", ".scratch/e\u0301.md"]]) test(`context aliases block: ${pair.join(",")}`, async () => {
  const result = await scenario({ files: pair }); assert.equal(result.starts, 0); assert.match(result.output.details.tickets.T1.reason, /aliases collide/);
});
test("Git metadata path rejected at staging seam", async () => {
  const result = await scenario({ prepare({ root, input }) { fs.writeFileSync(path.join(root, ".git/context.md"), "private"); input.tickets[0].specPaths.push(".git/context.md"); } });
  assert.equal(result.creates, 1); assert.equal(result.starts, 0); assert.match(result.output.details.tickets.T1.reason, /unsafe context path/);
});
test("file ancestor conflict rejected before copy", async () => {
  const result = await scenario({ prepare({ input }) { input.tickets[0].specPaths.push(".scratch/delivery/contracts"); }, expectedError: /context file is unavailable/ });
  assert.equal(result.starts, 0);
});
test("current ownership overlap blocks", async () => {
  const result = await scenario({ prepare({ input }) { input.tickets[0].ownedPaths.push(".scratch/"); } });
  assert.equal(result.starts, 0); assert.match(result.output.details.tickets.T1.reason, /ownership/);
});
test("unowned edit blocks despite valid context", async () => {
  const result = await scenario({ started({ tree }) { fs.writeFileSync(path.join(tree, "outside.txt"), "outside"); } });
  assert.equal(result.patch, null); assert.match(result.output.details.tickets.T1.reason, /ownership violation/);
});
test("source hard link blocked at bounded read", async () => {
  const result = await scenario({ created({ root }) { fs.linkSync(path.join(root, ".scratch/delivery/contracts/spec.md"), path.join(root, ".scratch/alias.md")); } });
  assert.equal(result.starts, 0); assert.match(result.output.details.tickets.T1.reason, /link/);
});
test("destination hard link blocks without overwriting", async () => {
  const result = await scenario({ created({ root, tree }) { const file = path.join(tree, ".scratch/delivery/contracts/spec.md"); fs.mkdirSync(path.dirname(file), { recursive: true }); const separate = path.join(tree, ".scratch/separate.md"); fs.writeFileSync(separate, Buffer.from("spec\r\n\0")); fs.linkSync(separate, file); } });
  assert.equal(result.starts, 0); assert.match(result.output.details.tickets.T1.reason, /collision/);
});
test("other ticket ownership does not reject current context", async () => {
  const result = await scenario({ prepare({ input }) {
    input.tickets.push({ ...input.tickets[0], id: "T2", dependencies: ["T1"], ownedPaths: [".scratch/"], worker: { ...input.tickets[0].worker, name: "other-worker" } });
  } }); assert.equal(result.starts, 1); assert.equal(result.output.details.tickets.T1.status, "validation_passed");
});
test("persisted disposition re-entry preserves legacy scope and stages downstream review", async () => {
  await scenario({ review: true, settled: async ({ root, input, core, output }) => {
    assert.equal(output.details.phase, "awaiting_disposition");
    const directory = path.join(root, ".scratch/delivery/context-run");
    const saved = JSON.parse(fs.readFileSync(path.join(directory, "run.json")));
    saved.tickets.push({ ...saved.tickets[0], id: "T2", dependencies: ["T1"], readPaths: ["tracked.md"], worker: { ...saved.tickets[0].worker, name: "second-reviewer" } });
    fs.writeFileSync(path.join(directory, "run.json"), JSON.stringify(saved));
    const state = JSON.parse(fs.readFileSync(path.join(directory, "status.json"))); state.tickets.T2 = { status: "pending" };
    fs.writeFileSync(path.join(directory, "status.json"), JSON.stringify(state));
    // Fake agent deliberately returns T1 result for T2: downstream staging/launch still occurs, result then blocks normally.
    const next = await core.dispose(root, { runId: input.runId, ticketId: "T1", disposition: "approve" });
    assert.equal(next.details.tickets.T1.status, "disposed"); assert.equal(next.details.phase, "blocked");
    assert.ok(fs.existsSync(path.join(input.worktreeRoot, "context-run-T2/.scratch/delivery/contracts/spec.md")));
    const persisted = JSON.parse(fs.readFileSync(path.join(directory, "status.json"))); assert.notEqual(persisted.phase, "running");
  } });
});
