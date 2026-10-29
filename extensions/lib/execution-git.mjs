import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateExecutionContract, verifyExecutionContext } from "./execution-contract.mjs";
import { isPathInside } from "./worktree-root.mjs";
import { buildChildEnvironment } from "./herdr.mjs";
import { parsePorcelainV1Z } from "./scheduler.mjs";
const exec = promisify(execFile);
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
async function git(root, args, signal) {
  return (await exec("git", ["--no-optional-locks", ...args], { cwd: root, env: buildChildEnvironment(), encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024, shell: false, signal })).stdout;
}
function realDirectory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value || fs.realpathSync(value) !== value || !fs.lstatSync(value).isDirectory()) throw new Error("Git proof requires canonical directory");
  return value;
}
async function snapshot(root, signal) {
  const top = realDirectory((await git(root, ["rev-parse", "--show-toplevel"], signal)).trim());
  if (top !== root) throw new Error("Git checkout top-level mismatch");
  const common = fs.realpathSync(path.resolve(root, (await git(root, ["rev-parse", "--git-common-dir"], signal)).trim()));
  const head = (await git(root, ["rev-parse", "HEAD"], signal)).trim();
  const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], signal);
  return { common, head, clean: status.length === 0, changedPaths: parsePorcelainV1Z(status) };
}

// Read-only proof for future host adapter. Caller must establish inactive exact actor identity independently.
export async function inspectExecutionGit({ contract, candidatePath, candidateCommit, worktreeRoot, ownedPaths, signal }) {
  const approved = validateExecutionContract(contract);
  if (typeof candidateCommit !== "string" || !SHA.test(candidateCommit)) throw new Error("candidate commit is invalid");
  const parent = realDirectory(approved.repositoryPath); const candidate = realDirectory(candidatePath); const root = realDirectory(worktreeRoot);
  if (!isPathInside(root, candidate) || candidate === parent || isPathInside(parent, candidate)) throw new Error("candidate must be isolated under approved worktree root outside parent checkout");
  verifyExecutionContext(approved);
  verifyExecutionContext({ ...approved, repositoryPath: candidate });
  const before = await snapshot(parent, signal); const child = await snapshot(candidate, signal);
  if (before.common !== child.common) throw new Error("candidate belongs to different Git repository");
  if (before.head !== approved.baseSha || !before.clean) throw new Error("parent checkout changed from approved base");
  if (child.head !== candidateCommit || (!ownedPaths && !child.clean)) throw new Error("candidate checkpoint is dirty or moved");
  if (ownedPaths) {
    if (!Array.isArray(ownedPaths) || !ownedPaths.length || ownedPaths.some(claim => !approved.steps.some(step => step.ownedPaths.includes(claim)))) throw new Error("candidate ownership exceeds approved scope");
    for (const file of child.changedPaths) if (!ownedPaths.some(claim => file === claim || (claim.endsWith("/") && file.startsWith(claim)))) throw new Error(`candidate ownership violation: ${file}`);
  }
  await git(candidate, ["merge-base", "--is-ancestor", approved.baseSha, candidateCommit], signal);
  const childAfter = await snapshot(candidate, signal);
  if (childAfter.head !== child.head || childAfter.clean !== child.clean || JSON.stringify(childAfter.changedPaths) !== JSON.stringify(child.changedPaths) || childAfter.common !== child.common) throw new Error("candidate changed during proof");
  const after = await snapshot(parent, signal);
  if (after.head !== before.head || !after.clean || after.common !== before.common) throw new Error("parent checkout changed during proof");
  verifyExecutionContext(approved);
  verifyExecutionContext({ ...approved, repositoryPath: candidate });
  return { verified: true, repositoryPath: parent, parentHead: before.head, parentClean: true, candidateCommit: child.head, candidateClean: child.clean, changedPaths: child.changedPaths, contextUnchanged: true };
}
