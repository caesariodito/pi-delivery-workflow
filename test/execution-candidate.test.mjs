import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { contract } from "./fixtures/execution-contract.mjs";
import { validateExecutionCandidate } from "../extensions/lib/execution-candidate.mjs";
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "execution-candidate-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parent = path.join(root, "repo"); const worktreeRoot = path.join(root, "worktrees"); const evidenceDirectory = path.join(root, "evidence");
  for (const directory of [parent, worktreeRoot, evidenceDirectory]) fs.mkdirSync(directory, { mode: 0o700 });
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(parent, "init", "-q"); git(parent, "config", "user.email", "test@example.com"); git(parent, "config", "user.name", "Test"); fs.writeFileSync(path.join(parent, "plan.md"), "approved\n"); git(parent, "add", "."); git(parent, "commit", "-qm", "docs: base");
  const c = contract(parent); c.baseSha = git(parent, "rev-parse", "HEAD"); c.validation[0].executable = process.execPath; c.validation[0].args = ["-e", "process.exit(0)"];
  const candidatePath = path.join(worktreeRoot, "candidate"); git(parent, "worktree", "add", "--detach", candidatePath, c.baseSha); fs.mkdirSync(path.join(candidatePath, "src")); fs.writeFileSync(path.join(candidatePath, "src", "feature.js"), "export const x = 1;\n");
  return { args: { contract: c, candidatePath, candidateCommit: c.baseSha, worktreeRoot, step: c.steps[0], operationId: "operation-1", evidenceDirectory, timeoutMs: 10_000 }, parent, candidatePath, git };
}

test("approved checks create scoped checkpoint without touching parent", async t => {
  const { args, parent, candidatePath, git } = fixture(t); const result = await validateExecutionCandidate(args);
  assert.equal(result.passed, true); assert.notEqual(result.candidateCommit, args.contract.baseSha); assert.equal(git(parent, "rev-parse", "HEAD"), args.contract.baseSha); assert.equal(git(candidatePath, "status", "--porcelain"), ""); assert.deepEqual(result.coveredCriteria, ["A1"]);
});

test("unowned file blocks before validation or commit", async t => {
  const { args, candidatePath, git } = fixture(t); fs.writeFileSync(path.join(candidatePath, "outside.txt"), "x");
  await assert.rejects(validateExecutionCandidate(args), /ownership violation/); assert.equal(git(candidatePath, "rev-parse", "HEAD"), args.contract.baseSha); assert.deepEqual(fs.readdirSync(args.evidenceDirectory), []);
});

test("failed checks retain dirty work and never checkpoint", async t => {
  const { args, candidatePath, git } = fixture(t); args.contract.validation[0].args = ["-e", "process.exit(7)"];
  const result = await validateExecutionCandidate(args); assert.equal(result.passed, false); assert.equal(result.checks[0].code, 7); assert.equal(git(candidatePath, "rev-parse", "HEAD"), args.contract.baseSha);
});

test("commit hook tree mutation rejects validated checkpoint", async t => {
  const { args, parent } = fixture(t);
  const hook = path.join(parent, ".git", "hooks", "pre-commit"); fs.writeFileSync(hook, "#!/bin/sh\nprintf 'changed\\n' > src/feature.js\ngit add src/feature.js\n", { mode: 0o700 });
  await assert.rejects(validateExecutionCandidate(args), /hook changed validated tree/);
});

test("validation mutation outside ownership is rejected", async t => {
  const { args } = fixture(t); args.contract.validation[0].args = ["-e", "require('node:fs').writeFileSync('outside.txt','x')"];
  await assert.rejects(validateExecutionCandidate(args), /ownership violation/);
});


test("successful check cannot mutate owned source and retain passing evidence", async t => {
  const { args, candidatePath, git } = fixture(t); args.contract.validation[0].args = ["-e", "require('node:fs').writeFileSync('src/feature.js','changed')"];
  await assert.rejects(validateExecutionCandidate(args), /mutated source/); assert.equal(git(candidatePath, "rev-parse", "HEAD"), args.contract.baseSha);
});
