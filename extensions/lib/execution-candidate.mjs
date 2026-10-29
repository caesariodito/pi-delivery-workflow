import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateExecutionContract } from "./execution-contract.mjs";
import { inspectExecutionGit } from "./execution-git.mjs";
import { buildChildEnvironment } from "./herdr.mjs";
import { runValidation } from "../delivery-workflow-core.mjs";
const exec = promisify(execFile);
async function git(root, args, signal, timeout) { return (await exec("git", args, { cwd: root, env: buildChildEnvironment(), encoding: "utf8", shell: false, timeout, maxBuffer: 2 * 1024 * 1024, signal })).stdout.trim(); }
const hash = value => createHash("sha256").update(value).digest("hex");

// ponytail: one inactive writer, existing candidate worktree; creation, actor control and explicit resume belong to host adapter.
export async function validateExecutionCandidate({ contract, candidatePath, candidateCommit, worktreeRoot, step, operationId, evidenceDirectory, timeoutMs, signal }) {
  const approved = validateExecutionContract(contract);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || typeof operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operationId)) throw new Error("candidate validation operation is invalid");
  if (!step || !Array.isArray(step.ownedPaths) || !step.ownedPaths.length) throw new Error("candidate validation requires approved ownership");
  if (!path.isAbsolute(evidenceDirectory) || fs.realpathSync(evidenceDirectory) !== evidenceDirectory || !fs.lstatSync(evidenceDirectory).isDirectory()) throw new Error("evidence directory must be canonical");
  const stat = fs.statSync(evidenceDirectory);
  if (process.platform !== "win32" && ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()))) throw new Error("evidence directory must be private and owned");
  const deadline = Date.now() + timeoutMs;
  const remaining = () => { if (signal?.aborted || Date.now() >= deadline) throw new Error("candidate validation stopped or deadline exhausted"); return deadline - Date.now(); };
  const proof = () => inspectExecutionGit({ contract: approved, candidatePath, candidateCommit, worktreeRoot, ownedPaths: step.ownedPaths, signal });
  const initialProof = await proof();
  const trackedFiles = (await exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: candidatePath, env: buildChildEnvironment(), shell: false, signal, timeout: remaining(), maxBuffer: 2 * 1024 * 1024 })).stdout.split("\0").filter(Boolean);
  const sourceDigest = () => {
    const digest = createHash("sha256");
    for (const file of trackedFiles.sort()) {
      const location = path.join(candidatePath, file); digest.update(file).update("\0");
      try { const stat = fs.lstatSync(location); if (stat.size > 32 * 1024 * 1024) throw new Error("source file exceeds checkpoint proof limit"); digest.update(String(stat.mode)); digest.update(stat.isSymbolicLink() ? fs.readlinkSync(location) : fs.readFileSync(location)); }
      catch (error) { if (error.code !== "ENOENT") throw error; digest.update("missing"); }
    }
    return digest.digest("hex");
  };
  const validatedSources = sourceDigest();
  const checks = [];
  for (const check of approved.validation) {
    const result = await runValidation(check, candidatePath, Math.min(check.timeoutSeconds * 1000, remaining()), { signal });
    const logPath = path.join(evidenceDirectory, `${operationId}-${check.id}.log`);
    const body = `${result.stdout}${result.stderr}`;
    const fd = fs.openSync(logPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.writeFileSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    checks.push({ id: check.id, passed: result.passed, code: result.code, timedOut: result.timedOut, outputExceeded: result.outputExceeded, logPath, logSha256: hash(body) });
    const afterCheck = await proof(); remaining();
    if (JSON.stringify(afterCheck.changedPaths) !== JSON.stringify(initialProof.changedPaths)) throw new Error("validation changed source inventory; evidence invalid");
    if (sourceDigest() !== validatedSources) throw new Error("validation mutated source files; evidence invalid");
    if (!result.passed) return { passed: false, candidateCommit, checks, coveredCriteria: [] };
  }
  const inspected = await proof(); remaining();
  if (inspected.changedPaths.length) {
    // Stage only observed owned paths. Disable pathspec interpretation; no git add -A outside scope.
    await git(candidatePath, ["--literal-pathspecs", "add", "--", ...inspected.changedPaths], signal, remaining());
    await proof();
    const tree = await git(candidatePath, ["write-tree"], signal, remaining());
    await git(candidatePath, ["commit", "-m", `feat(delivery): checkpoint ${operationId}`], signal, remaining());
    const committedTree = await git(candidatePath, ["rev-parse", "HEAD^{tree}"], signal, remaining());
    candidateCommit = await git(candidatePath, ["rev-parse", "HEAD"], signal, remaining());
    if (committedTree !== tree) throw new Error("commit hook changed validated tree; checkpoint requires inspection and revalidation");
    const parents = (await git(candidatePath, ["rev-list", "--parents", "-n", "1", "HEAD"], signal, remaining())).split(" ");
    if (parents.length !== 2 || parents[1] !== inspected.candidateCommit) throw new Error("checkpoint ancestry changed unexpectedly");
  }
  await inspectExecutionGit({ contract: approved, candidatePath, candidateCommit, worktreeRoot, signal }); remaining();
  return { passed: true, candidateCommit, checks, coveredCriteria: [...new Set(approved.validation.flatMap(check => check.criteria))] };
}
