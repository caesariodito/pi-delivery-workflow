import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { contract } from "./fixtures/execution-contract.mjs";
import { inspectExecutionGit } from "../extensions/lib/execution-git.mjs";
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "execution-git-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parent = path.join(root, "repo"); const worktreeRoot = path.join(root, "worktrees"); fs.mkdirSync(parent); fs.mkdirSync(worktreeRoot);
  const git = (...args) => execFileSync("git", args, { cwd: parent, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test"); fs.writeFileSync(path.join(parent, "plan.md"), "approved\n"); git("add", "plan.md"); git("commit", "-qm", "docs: approved plan");
  const c = contract(parent); c.baseSha = git("rev-parse", "HEAD"); const candidatePath = path.join(worktreeRoot, "candidate"); git("worktree", "add", "--detach", candidatePath, c.baseSha);
  return { args: { contract: c, candidatePath, candidateCommit: c.baseSha, worktreeRoot }, parent, candidatePath, git };
}

test("real Git worktree proof verifies shared repository and unchanged parent", async t => {
  const { args } = fixture(t); const proof = await inspectExecutionGit(args); assert.equal(proof.verified, true); assert.equal(proof.parentHead, args.contract.baseSha); assert.equal(proof.writerInactive, undefined);
});

test("dirty parent or candidate invalidates recovery proof", async t => {
  const { args, parent, candidatePath } = fixture(t);
  fs.writeFileSync(path.join(candidatePath, "untracked"), "x"); await assert.rejects(inspectExecutionGit(args), /candidate checkpoint/); fs.unlinkSync(path.join(candidatePath, "untracked"));
  fs.writeFileSync(path.join(parent, "untracked"), "x"); await assert.rejects(inspectExecutionGit(args), /parent checkout/);
});

test("wrong checkpoint, root and repository fail closed", async t => {
  const { args, parent } = fixture(t);
  await assert.rejects(inspectExecutionGit({ ...args, candidateCommit: "a".repeat(40) }), /checkpoint/);
  await assert.rejects(inspectExecutionGit({ ...args, candidatePath: parent }), /isolated/);
  await assert.rejects(inspectExecutionGit({ ...args, worktreeRoot: parent }), /isolated/);
});
