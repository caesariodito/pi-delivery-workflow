import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const fail = (message) => { throw new TypeError(message); };
function object(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail(`${label} fields are invalid`);
}
function text(value, label, maximum = 16_000) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) fail(`${label} must be bounded nonempty text`);
}
function list(value, label, maximum, minimum = 1) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail(`${label} length is invalid`);
}
function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${label} must be an integer from ${minimum} to ${maximum}`);
}
function id(value, label) { if (typeof value !== "string" || !ID.test(value)) fail(`${label} is invalid`); }
function relative(value, label, directory = false) {
  text(value, label, 4096);
  if (value === "." || value.includes("\\") || value.startsWith("/") || value.split("/").some((part, index, parts) => part === "." || part === ".." || (!part && !(directory && index === parts.length - 1))) || value.split("/").some((part) => part.toLowerCase() === ".git") || path.posix.normalize(value) !== value) fail(`${label} must be a normalized repository-relative path`);
}
function unique(values, label) { if (new Set(values).size !== values.length) fail(`${label} must be unique`); }
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
// ponytail: canonicalization supports validated JSON contracts only; add a formal scheme if external signers are introduced.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function validateExecutionContract(value) {
  object(value, ["version", "runId", "repositoryPath", "baseSha", "objective", "criteria", "context", "steps", "actors", "permissions", "limits", "validation", "reviewPolicy"], "contract");
  if (value.version !== 1) fail("unsupported execution contract version");
  id(value.runId, "runId"); text(value.repositoryPath, "repositoryPath", 4096);
  if (!path.isAbsolute(value.repositoryPath) || path.normalize(value.repositoryPath) !== value.repositoryPath) fail("repositoryPath must be normalized and absolute");
  if (typeof value.baseSha !== "string" || !SHA.test(value.baseSha)) fail("baseSha is invalid");
  text(value.objective, "objective");
  list(value.criteria, "criteria", 64);
  for (const criterion of value.criteria) { object(criterion, ["id", "condition"], "criterion"); id(criterion.id, "criterion id"); text(criterion.condition, "criterion condition"); }
  unique(value.criteria.map((item) => item.id), "criterion IDs");
  const criteria = new Set(value.criteria.map((item) => item.id));
  list(value.context, "context", 32);
  for (const item of value.context) { object(item, ["path", "sha256"], "context item"); relative(item.path, "context path"); if (!HASH.test(item.sha256)) fail("context hash is invalid"); }
  unique(value.context.map((item) => item.path.normalize("NFC").toLowerCase()), "context paths");
  object(value.limits, ["wallTimeSeconds", "maxRemediationRounds", "maxNoProgressAttempts", "maxSteps", "maxActorLaunches"], "limits");
  integer(value.limits.wallTimeSeconds, "wallTimeSeconds", 60, 86_400);
  integer(value.limits.maxRemediationRounds, "maxRemediationRounds", 0, 10);
  integer(value.limits.maxNoProgressAttempts, "maxNoProgressAttempts", 1, 10);
  integer(value.limits.maxSteps, "maxSteps", 1, 64);
  integer(value.limits.maxActorLaunches, "maxActorLaunches", 2, 256);
  list(value.steps, "steps", value.limits.maxSteps);
  const seen = new Set(); const covered = new Set();
  for (const step of value.steps) {
    object(step, ["id", "goal", "ownedPaths", "dependsOn", "criteria"], "step"); id(step.id, "step id"); text(step.goal, "step goal");
    if (seen.has(step.id)) fail("step IDs must be unique");
    list(step.dependsOn, "step dependencies", 64, 0); unique(step.dependsOn, "step dependencies");
    if (step.dependsOn.some((dependency) => !seen.has(dependency))) fail("steps must be in dependency order");
    seen.add(step.id);
    list(step.ownedPaths, "ownedPaths", 64); unique(step.ownedPaths, "ownedPaths");
    for (const item of step.ownedPaths) { relative(item, "owned path", item.endsWith("/")); if (item.startsWith(".scratch/")) fail("runtime evidence cannot be owned"); }
    list(step.criteria, "step criteria", 64); unique(step.criteria, "step criteria");
    for (const criterion of step.criteria) { if (!criteria.has(criterion)) fail("unknown acceptance criterion"); covered.add(criterion); }
    if (value.context.some((item) => step.ownedPaths.some((owned) => item.path === owned || (owned.endsWith("/") && item.path.startsWith(owned))))) fail("approved context cannot be writable");
  }
  if (covered.size !== criteria.size) fail("every criterion must be covered by a step");
  object(value.actors, ["supervisor", "writer", "reviewer"], "actors");
  for (const [role, actor] of Object.entries(value.actors)) {
    object(actor, ["model", "thinking", "tools"], `${role} actor`); text(actor.model, "model", 256);
    if (!["minimal", "low", "medium"].includes(actor.thinking)) fail("thinking must not exceed medium");
    list(actor.tools, "actor tools", 16); unique(actor.tools, "actor tools");
    if (actor.tools.some((tool) => !["read", "write", "edit", "bash"].includes(tool))) fail("unsupported actor tool");
    if (role === "reviewer" && (actor.tools.length !== 1 || actor.tools[0] !== "read")) fail("reviewer must have read only");
  }
  if (value.actors.writer.model === value.actors.reviewer.model) fail("reviewer must use an independent model");
  object(value.permissions, ["candidateCommits", "interrupt", "parentWrites", "publication", "cleanup"], "permissions");
  if (value.permissions.candidateCommits !== true || typeof value.permissions.interrupt !== "boolean" || value.permissions.parentWrites !== false || value.permissions.publication !== false || value.permissions.cleanup !== false) fail("unsupported execution permissions");
  list(value.validation, "validation", 16);
  for (const check of value.validation) {
    object(check, ["id", "executable", "args", "cwd", "timeoutSeconds", "criteria"], "validation"); id(check.id, "check id"); text(check.executable, "executable", 1024);
    list(check.args, "command args", 256, 0); for (const arg of check.args) if (typeof arg !== "string" || arg.length > 8192 || arg.includes("\0")) fail("command argument is invalid");
    if (check.cwd !== ".") relative(check.cwd, "validation cwd"); integer(check.timeoutSeconds, "validation timeout", 1, 1800);
    list(check.criteria, "check criteria", 64); unique(check.criteria, "check criteria"); if (check.criteria.some((criterion) => !criteria.has(criterion))) fail("check references unknown criterion");
  }
  unique(value.validation.map((check) => check.id), "check IDs");
  if ([...criteria].some((criterion) => !value.validation.some((check) => check.criteria.includes(criterion)))) fail("every criterion requires a validation check");
  object(value.reviewPolicy, ["freshContext", "evidenceRequired", "unresolvedFindingsBlock"], "review policy");
  if (Object.values(value.reviewPolicy).some((flag) => flag !== true)) fail("review evidence and unresolved-finding gates cannot be disabled");
  const body = canonical(value); if (Buffer.byteLength(body) > 256 * 1024) fail("execution contract exceeds 256 KiB");
  return JSON.parse(body);
}

export function executionContractDigest(value) { return hash(`pi-execution-contract:v1\0${canonical(validateExecutionContract(value))}`); }

export function verifyExecutionApproval(contract, approval, now = Date.now()) {
  integer(now, "current time", 0, Number.MAX_SAFE_INTEGER);
  object(approval, ["contractDigest", "approvedBy", "approvedAt"], "approval"); text(approval.approvedBy, "approver", 256);
  if (approval.contractDigest !== executionContractDigest(contract)) fail("approval digest does not match execution contract");
  if (typeof approval.approvedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(approval.approvedAt) || !Number.isFinite(Date.parse(approval.approvedAt)) || new Date(approval.approvedAt).toISOString() !== approval.approvedAt || Date.parse(approval.approvedAt) > now) fail("approval timestamp is invalid");
  return true;
}

export function verifyExecutionContext(contract) {
  const value = validateExecutionContract(contract); const root = fs.realpathSync(value.repositoryPath);
  if (root !== value.repositoryPath) fail("repository identity is not canonical");
  for (const item of value.context) {
    let current = root;
    for (const segment of item.path.split("/")) { current = path.join(current, segment); const stat = fs.lstatSync(current); if (stat.isSymbolicLink()) fail("context symlink is forbidden"); }
    const fd = fs.openSync(current, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024) fail("context must be a bounded regular file without hard links");
      const buffer = Buffer.alloc(256 * 1024 + 1); let length = 0;
      while (length < buffer.length) { const count = fs.readSync(fd, buffer, length, buffer.length - length, null); if (!count) break; length += count; }
      if (length > 256 * 1024 || hash(buffer.subarray(0, length)) !== item.sha256) fail(`approved context bytes changed: ${item.path}`);
    } finally { fs.closeSync(fd); }
  }
  return true;
}

export function admitExecutionOperation(contract, state, operation, now = Date.now()) {
  integer(now, "current time", 0, Number.MAX_SAFE_INTEGER);
  const value = validateExecutionContract(contract);
  object(state, ["contractDigest", "startedAt", "deadlineAt", "actorLaunches", "remediationRounds", "noProgressAttempts"], "execution budget");
  if (state.contractDigest !== executionContractDigest(value)) fail("execution budget contract mismatch");
  integer(state.startedAt, "startedAt", 0, Number.MAX_SAFE_INTEGER); integer(state.deadlineAt, "deadlineAt", 0, Number.MAX_SAFE_INTEGER);
  if (state.startedAt > now || state.deadlineAt !== state.startedAt + value.limits.wallTimeSeconds * 1000) fail("execution deadline drift");
  for (const key of ["actorLaunches", "remediationRounds", "noProgressAttempts"]) integer(state[key], key, 0, Number.MAX_SAFE_INTEGER);
  if (!["launch", "repair", "validate", "review"].includes(operation)) fail("unknown execution operation");
  if (now >= state.deadlineAt) fail("execution deadline exhausted");
  if (state.actorLaunches >= value.limits.maxActorLaunches && ["launch", "review"].includes(operation)) fail("actor launch budget exhausted");
  if (operation === "repair" && state.remediationRounds >= value.limits.maxRemediationRounds) fail("remediation budget exhausted");
  if (operation === "repair" && state.noProgressAttempts >= value.limits.maxNoProgressAttempts) fail("no-progress budget exhausted");
  return { remainingMs: state.deadlineAt - now };
}
