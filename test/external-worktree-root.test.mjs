import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import deliveryWorkflow from "../extensions/delivery-workflow.ts";
import { Check } from "typebox/value";
import { isPathInside, normalizeRepositoryIdentity, repositoryIdentity, repositorySlug, resolveWorktreeRoot } from "../extensions/lib/worktree-root.mjs";

function fakePi() {
  const tools = new Map();
  return { tools, registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {}, sendUserMessage() {} };
}

function input() {
  return { runId: "root-test", objective: "Test root", baseSha: "0".repeat(40), tickets: [{ id: "T1", goal: "Test", definitionOfDone: "Done", dependencies: [], ownedPaths: ["a.txt"], worker: { name: "worker", kind: "worker", model: "9router/cx/gpt-5.6-sol", thinking: "medium", tools: ["read"] }, validation: { executable: "true", args: [] } }] };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-root-test-"));
  const home = path.join(root, "home");
  const repository = path.join(root, "same name");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(repository);
  return { root, home: fs.realpathSync(home), repository: fs.realpathSync(repository) };
}

function cleanup(value) { fs.rmSync(value.root, { recursive: true, force: true }); }

const guidance = /Provide worktreeRoot as a writable normalized absolute real directory outside the repository/;

test("start schema makes only worktreeRoot optional and preview stays no-write", async () => {
  const pi = fakePi(); deliveryWorkflow(pi);
  const start = pi.tools.get("delivery_start").parameters;
  const preview = pi.tools.get("delivery_preview").parameters;
  const value = input();
  assert.equal(Check(start, value), true);
  assert.equal(Check(start, { ...value, worktreeRoot: "/safe/root" }), true);
  assert.equal(Check(start, { ...value, worktreeRoot: 3 }), false);
  assert.equal(Check(start, { ...value, unknown: true }), false);
  assert.equal(Check(preview, value), true);
  assert.equal(Check(preview, { ...value, worktreeRoot: "/safe/root" }), false);
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-preview-test-"));
  const previousTmpdir = process.env.TMPDIR;
  try {
    process.env.TMPDIR = temporaryDirectory;
    const before = new Set(fs.readdirSync(temporaryDirectory));
    await pi.tools.get("delivery_preview").execute("id", value, undefined, undefined, { cwd: temporaryDirectory });
    assert.deepEqual(new Set(fs.readdirSync(temporaryDirectory)), before);
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmpdir;
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("repository identity uses exact versioned canonical path bytes", () => {
  const canonical = "/srv/Clone";
  const expected = crypto.createHash("sha256").update("pi-delivery-worktree-root:v1\0/srv/Clone").digest("hex");
  assert.equal(repositoryIdentity(canonical, path.posix), expected);
  assert.equal(repositoryIdentity("/srv/Clone/", path.posix), expected);
  assert.notEqual(repositoryIdentity("/other/Clone", path.posix), expected);
  assert.equal(repositoryIdentity("C:/Users/Alice/Repo/", path.win32), repositoryIdentity("c:\\users\\alice\\repo", path.win32));
  assert.equal(repositoryIdentity(canonical, path.posix).length, 64);
  assert.equal(repositorySlug("/srv/. odd repo !!!", path.posix), "odd-repo");
  assert.equal(repositorySlug("/srv/---", path.posix), "repository");
  assert.equal(normalizeRepositoryIdentity("C:/Users/Alice/Repo/", path.win32), "c:\\users\\alice\\repo");
});

test("component-aware containment handles equality, siblings, case, and volumes", () => {
  assert.equal(isPathInside("/repo", "/repo/ticket", path.posix), true);
  assert.equal(isPathInside("/repo", "/repo", path.posix), false);
  assert.equal(isPathInside("/repo", "/repository", path.posix), false);
  assert.equal(isPathInside("C:\\Users\\Alice", "c:/users/alice/work", path.win32), true);
  assert.equal(isPathInside("C:\\Users\\Alice", "D:\\Users\\Alice\\work", path.win32), false);
  assert.equal(isPathInside("C:\\Repo", "C:\\RepoSibling", path.win32), false);
});

test("derived root is persistent, private, canonical, and repository-specific", () => {
  const f = fixture();
  try {
    const first = resolveWorktreeRoot(f.repository, undefined, { home: f.home });
    const second = resolveWorktreeRoot(f.repository, undefined, { home: f.home });
    assert.deepEqual(second, first);
    assert.equal(first.provenance, "derived");
    assert.equal(first.worktreeRoot.startsWith(path.join(f.home, ".pi", "delivery-worktrees", "v1") + path.sep), true);
    assert.equal(first.worktreeRoot.includes(os.tmpdir() + path.sep + "delivery-worktrees-"), false);
    assert.match(path.basename(first.worktreeRoot), /^same-name-[0-9a-f]{64}$/);
    if (process.platform !== "win32" && process.getuid) {
      for (const directory of [path.join(f.home, ".pi", "delivery-worktrees"), path.join(f.home, ".pi", "delivery-worktrees", "v1"), first.worktreeRoot]) assert.equal(fs.statSync(directory).mode & 0o022, 0);
    }
  } finally { cleanup(f); }
});

test("explicit override must exist unchanged outside repository", () => {
  const f = fixture(); const override = path.join(f.root, "operator-root"); fs.mkdirSync(override, { mode: 0o750 });
  try {
    const before = fs.statSync(override).mode;
    assert.deepEqual(resolveWorktreeRoot(f.repository, override, { home: f.home }), { worktreeRoot: fs.realpathSync(override), provenance: "override" });
    assert.equal(fs.statSync(override).mode, before);
    assert.throws(() => resolveWorktreeRoot(f.repository, path.join(f.repository, "inside"), { home: f.home }), guidance);
    assert.throws(() => resolveWorktreeRoot(f.repository, path.join(f.root, "missing"), { home: f.home }), guidance);
    const file = path.join(f.root, "file"); fs.writeFileSync(file, "x"); assert.throws(() => resolveWorktreeRoot(f.repository, file, { home: f.home }), guidance);
    const link = path.join(f.root, "link"); fs.symlinkSync(override, link); assert.throws(() => resolveWorktreeRoot(f.repository, link, { home: f.home }), guidance);
    assert.throws(() => resolveWorktreeRoot(f.repository, `${override}${path.sep}..${path.sep}operator-root`, { home: f.home }), guidance);
  } finally { cleanup(f); }
});

test("derived failures give override guidance without fallback", () => {
  const f = fixture();
  try {
    assert.throws(() => resolveWorktreeRoot(f.repository, undefined, { home: path.join(f.root, "missing-home") }), guidance);
    const pi = path.join(f.home, ".pi"); fs.writeFileSync(pi, "not a directory");
    assert.throws(() => resolveWorktreeRoot(f.repository, undefined, { home: f.home }), guidance);
  } finally { cleanup(f); }

  const symlinkFixture = fixture();
  try {
    const pi = path.join(symlinkFixture.home, ".pi"); const target = path.join(symlinkFixture.root, "target"); fs.mkdirSync(pi); fs.mkdirSync(target); fs.symlinkSync(target, path.join(pi, "delivery-worktrees"));
    assert.throws(() => resolveWorktreeRoot(symlinkFixture.repository, undefined, { home: symlinkFixture.home }), guidance);
  } finally { cleanup(symlinkFixture); }
});

test("derived root rejects insecure mode and wrong ownership through stat seam", () => {
  const f = fixture();
  try {
    const insecureFs = Object.create(fs);
    insecureFs.lstatSync = (value) => { const stat = fs.lstatSync(value); return value.includes("delivery-worktrees") ? Object.assign(Object.create(stat), { mode: stat.mode | 0o022 }) : stat; };
    assert.throws(() => resolveWorktreeRoot(f.repository, undefined, { home: f.home, fs: insecureFs, platform: "linux", getuid: () => process.getuid?.() ?? 501 }), guidance);
    fs.rmSync(path.join(f.home, ".pi"), { recursive: true, force: true });
    const wrongOwnerFs = Object.create(fs);
    wrongOwnerFs.lstatSync = (value) => { const stat = fs.lstatSync(value); return value.includes("delivery-worktrees") ? Object.assign(Object.create(stat), { uid: 999999 }) : stat; };
    assert.throws(() => resolveWorktreeRoot(f.repository, undefined, { home: f.home, fs: wrongOwnerFs, platform: "linux", getuid: () => 501 }), guidance);
    fs.rmSync(path.join(f.home, ".pi"), { recursive: true, force: true });
    const unwritableFs = Object.create(fs);
    unwritableFs.accessSync = (value, mode) => { if (value.includes("delivery-worktrees")) throw new Error("denied"); return fs.accessSync(value, mode); };
    assert.throws(() => resolveWorktreeRoot(f.repository, undefined, { home: f.home, fs: unwritableFs }), guidance);
  } finally { cleanup(f); }
});
