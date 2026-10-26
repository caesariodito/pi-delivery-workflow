import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateCommandSpec, validateOwnedPaths, validateRelativePath, validateRunId, validateTicketId } from "./contracts.mjs";
import { createHandoffManifest, findOwnershipViolations, parsePorcelainV1Z, sha256 } from "./git-evidence.mjs";
import { atomicWriteJson, readJson } from "./state.mjs";
import { EXTRACTION_VERDICT } from "./herdr.mjs";

const MAX_TEXT = 128 * 1024;
const DEFAULT_PROCESS_TIMEOUT_MS = 120_000;
const DEFAULT_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
const REVIEW_TOOLS = Object.freeze(["read", "grep", "find", "ls"]);
const REVIEW_RESULT_TOOL = "delivery_result_write";
const REVIEW_EXTENSION = fileURLToPath(new URL("../reviewer-result-tool.ts", import.meta.url));
const RESULT_PROTOCOL = "result-file-pointer";
const REVIEW_VERDICTS = new Set(["ok", "needs_fix", "blocked"]);

export function absentPathHash(file) {
  return sha256(`absent\0${validateRelativePath(file, { allowDirectoryPrefix: false })}`);
}

function plain(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be a plain object.`);
  return value;
}

function exact(value, allowed, label) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new TypeError(`${label} contains unsupported fields: ${extra.join(", ")}.`);
}

function text(value, label, maximum = 4096) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) throw new TypeError(`${label} must be bounded non-empty text.`);
  return value;
}

function absolute(value, label) {
  const checked = text(value, label);
  if (!path.isAbsolute(checked) || path.normalize(checked) !== checked) throw new TypeError(`${label} must be a normalized absolute path.`);
  return checked;
}

function agent(value, label) {
  plain(value, label);
  exact(value, ["name", "kind", "pane", "model", "session"], label);
  return Object.freeze({
    name: text(value.name, `${label}.name`, 128),
    kind: text(value.kind, `${label}.kind`, 128),
    pane: text(value.pane, `${label}.pane`, 256),
    model: text(value.model, `${label}.model`, 256),
    session: text(value.session, `${label}.session`, 512),
  });
}

export function validateTicketRunContract(value) {
  plain(value, "ticket run contract");
  exact(value, ["version", "runId", "ticketId", "planApproved", "repositoryPath", "worktreePath", "baseSha", "branch", "ticket", "context", "ownedPaths", "forbiddenPaths", "validation", "maxFixRounds", "agentTimeoutMs", "worker", "reviewer", "artifactMappings"], "ticket run contract");
  if (value.version !== 1) throw new TypeError("ticket run contract version must be 1.");
  if (value.planApproved !== true) throw new Error("ticket run requires explicit plan approval.");
  if (typeof value.baseSha !== "string" || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value.baseSha)) throw new TypeError("baseSha must be a lowercase Git object ID.");
  if (!Number.isSafeInteger(value.maxFixRounds) || value.maxFixRounds < 0 || value.maxFixRounds > 2) throw new TypeError("maxFixRounds must be an integer from 0 through 2.");
  const agentTimeoutMs = value.agentTimeoutMs ?? 300_000;
  if (!Number.isSafeInteger(agentTimeoutMs) || agentTimeoutMs < 1 || agentTimeoutMs > 300_000) throw new TypeError("agentTimeoutMs must be an integer from 1 through 300000.");
  const artifactMappings = value.artifactMappings === undefined ? {} : plain(value.artifactMappings, "artifactMappings");
  for (const [source, target] of Object.entries(artifactMappings)) {
    validateRelativePath(source, { allowDirectoryPrefix: false });
    text(target, "artifact mapping target");
  }
  const checked = {
    version: 1,
    runId: validateRunId(value.runId),
    ticketId: validateTicketId(value.ticketId),
    planApproved: true,
    repositoryPath: absolute(value.repositoryPath, "repositoryPath"),
    worktreePath: absolute(value.worktreePath, "worktreePath"),
    baseSha: value.baseSha,
    branch: text(value.branch, "branch", 512),
    ticket: text(value.ticket, "ticket", MAX_TEXT),
    context: text(value.context, "context", MAX_TEXT),
    ownedPaths: validateOwnedPaths(value.ownedPaths).map((entry) => `${entry.path}${entry.directory ? "/" : ""}`),
    forbiddenPaths: validateOwnedPaths(value.forbiddenPaths).map((entry) => `${entry.path}${entry.directory ? "/" : ""}`),
    validation: validateCommandSpec(value.validation),
    maxFixRounds: value.maxFixRounds,
    agentTimeoutMs,
    worker: agent(value.worker, "worker"),
    reviewer: agent(value.reviewer, "reviewer"),
    artifactMappings: { ...artifactMappings },
  };
  if (Buffer.byteLength(checked.ticket) + Buffer.byteLength(checked.context) > MAX_TEXT) throw new TypeError(`ticket and context exceed ${MAX_TEXT} aggregate bytes.`);
  return deepFreeze(checked);
}

function deepFreeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  return Object.freeze(value);
}

export function createProcessRunner({ timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS, maxOutputBytes = DEFAULT_PROCESS_OUTPUT_BYTES } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new TypeError("timeoutMs must be an integer from 1 through 300000.");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 16 * 1024 * 1024) throw new TypeError("maxOutputBytes must be an integer from 1 through 16777216.");
  return Object.freeze({
    run(spec) {
      if (!spec || typeof spec.executable !== "string" || !Array.isArray(spec.args) || spec.args.some((arg) => typeof arg !== "string")) throw new TypeError("process spec requires executable and string args.");
      return new Promise((resolve, reject) => {
        const grouped = process.platform !== "win32";
        const child = spawn(spec.executable, spec.args, { cwd: spec.cwd, detached: grouped, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        const stdout = [];
        const stderr = [];
        let bytes = 0;
        let settled = false;
        let timer;
        const finish = (value, error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.stdout.destroy();
          child.stderr.destroy();
          if (error) reject(error); else resolve(value);
        };
        const terminate = (reason) => {
          try { if (grouped && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch (error) { if (error.code !== "ESRCH") return finish(undefined, error); }
          finish({ code: null, signal: "SIGKILL", timedOut: reason === "timeout", outputLimit: reason === "output-limit", stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
        };
        timer = setTimeout(() => terminate("timeout"), timeoutMs);
        const collect = (target) => (chunk) => {
          bytes += chunk.length;
          if (bytes > maxOutputBytes) return terminate("output-limit");
          target.push(chunk);
        };
        child.stdout.on("data", collect(stdout));
        child.stderr.on("data", collect(stderr));
        child.once("error", (error) => finish(undefined, error));
        child.once("close", (code, signal) => finish({ code, signal, timedOut: false, outputLimit: false, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
      });
    },
  });
}

function exclusiveWrite(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(filePath, flags, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return sha256(bytes);
}

function safeFile(root, filePath, label, beforeOpen) {
  const resolvedRoot = path.resolve(root);
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) || path.normalize(filePath) !== filePath) throw new Error(`${label} path must be normalized and absolute.`);
  const relative = path.relative(resolvedRoot, filePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${label} must be inside run directory.`);
  if (fs.constants.O_NOFOLLOW === undefined) throw new Error(`${label} requires O_NOFOLLOW support.`);
  if (beforeOpen) beforeOpen({ filePath, label });
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    const identity = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.nlink !== 1 || identity.isSymbolicLink() || identity.dev !== stat.dev || identity.ino !== stat.ino) throw new Error(`${label} must be a regular singly-linked stable file.`);
    if ((stat.mode & 0o777) !== 0o600) throw new Error(`${label} permissions must be 0600.`);
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_TEXT) throw new Error(`${label} exceeds ${MAX_TEXT} bytes.`);
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (count === 0) throw new Error(`${label} changed while reading.`); offset += count; }
    const extra = Buffer.alloc(1); if (fs.readSync(fd, extra, 0, 1, offset) !== 0) throw new Error(`${label} changed while reading.`);
    return bytes;
  } finally { fs.closeSync(fd); }
}

function publishManifest(runDirectory, manifestPath, manifest, { beforeOpen, afterCreate } = {}) {
  const normalized = createHandoffManifest(manifest);
  const bytes = Buffer.from(`${JSON.stringify(normalized)}\n`, "utf8");
  let created = false;
  try { exclusiveWrite(manifestPath, bytes); created = true; } catch (error) { if (error.code !== "EEXIST") throw error; }
  if (created && afterCreate) afterCreate({ manifestPath, bytes });
  const publishedBytes = safeFile(runDirectory, manifestPath, "handoff manifest", beforeOpen);
  let published;
  try { published = createHandoffManifest(JSON.parse(publishedBytes.toString("utf8"))); } catch (cause) { throw new Error("handoff manifest is malformed or conflicting.", { cause }); }
  if (!publishedBytes.equals(bytes) || JSON.stringify(published) !== JSON.stringify(normalized)) throw new Error("handoff manifest is malformed or conflicting.");
  return Object.freeze({ manifest: published, bytes: publishedBytes, sha256: sha256(publishedBytes) });
}

function requireAbsent(filePath, label) {
  try { fs.lstatSync(filePath); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error(`${label} already exists.`);
}

function readResult(runDirectory, resultPath, kind) {
  let value;
  let bytes;
  try { bytes = safeFile(runDirectory, resultPath, `${kind} result`); value = JSON.parse(bytes.toString("utf8")); } catch (cause) { throw new Error(`${kind} result is missing or invalid.`, { cause }); }
  plain(value, `${kind} result`);
  if (kind === "worker") {
    exact(value, ["version", "status", "summary"], "worker result");
    if (value.version !== 1 || !["done", "blocked"].includes(value.status)) throw new Error("worker result has invalid version or status.");
  } else {
    exact(value, ["version", "verdict", "findings", "summary", "candidateHash"], "review result");
    if (value.version !== 1 || !REVIEW_VERDICTS.has(value.verdict) || !Array.isArray(value.findings) || value.findings.length > 12) throw new Error("review result has invalid schema.");
    for (const finding of value.findings) {
      plain(finding, "review finding");
      exact(finding, ["severity", "location", "problem", "action"], "review finding");
      if (!["P0", "P1", "P2"].includes(finding.severity)) throw new Error("review finding severity is invalid.");
      for (const key of ["location", "problem", "action"]) text(finding[key], `review finding ${key}`, 8192);
    }
    if (!/^[0-9a-f]{64}$/.test(value.candidateHash)) throw new Error("review candidateHash must be a SHA-256 digest.");
    const major = value.findings.some((finding) => finding.severity === "P0" || finding.severity === "P1");
    if (value.verdict === "ok" && major) throw new Error("ok review must not contain P0 or P1 findings.");
    if (value.verdict === "needs_fix" && value.findings.length === 0) throw new Error("needs_fix review requires findings.");
  }
  text(value.summary, `${kind} result summary`, 16_000);
  return Object.freeze({ ...value, ...(value.findings ? { findings: Object.freeze(value.findings.map((item) => Object.freeze({ ...item }))) } : {}), sha256: sha256(bytes) });
}

async function command(processRunner, executable, args, cwd) {
  const result = await processRunner.run({ executable, args, cwd });
  if (!result || result.code !== 0 || result.signal || result.timedOut || result.outputLimit) throw new Error(`${executable} ${args.join(" ")} failed with exit ${result?.code ?? "unknown"}${result?.signal ? ` signal ${result.signal}` : ""}${result?.timedOut ? " timeout" : ""}${result?.outputLimit ? " output-limit" : ""}: ${String(result?.stderr ?? "")}`);
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
}

async function captureGit(processRunner, contract) {
  const cwd = contract.worktreePath;
  const [headBuffer, branchBuffer, status, patch, diffNames] = await Promise.all([
    command(processRunner, "git", ["rev-parse", "HEAD"], cwd),
    command(processRunner, "git", ["branch", "--show-current"], cwd),
    command(processRunner, "git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd),
    command(processRunner, "git", ["diff", "--binary", "--no-ext-diff", "--no-textconv", contract.baseSha, "--"], cwd),
    command(processRunner, "git", ["diff", "--name-only", "--no-textconv", "-z", contract.baseSha, "--"], cwd),
  ]);
  const headSha = headBuffer.toString("utf8").trim();
  const branch = branchBuffer.toString("utf8").trim();
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(headSha)) throw new Error("Git returned invalid HEAD.");
  if (branch !== contract.branch) throw new Error(`Git branch drifted: expected ${contract.branch}, found ${branch || "detached"}.`);
  const entries = parsePorcelainV1Z(status);
  // ponytail: Git status omits ignored files; use an explicit owned-path index if ignored deliverables become supported, never scan node_modules or .scratch.
  const evidenceRelative = path.relative(cwd, path.join(contract.repositoryPath, ".scratch", "delivery", contract.runId, contract.ticketId)).split(path.sep).join("/");
  const isRunnerEvidence = (file) => evidenceRelative && evidenceRelative !== ".." && !evidenceRelative.startsWith("../") && (file === evidenceRelative || file.startsWith(`${evidenceRelative}/`));
  const untrackedPatches = [];
  for (const entry of entries.filter((item) => item.status === "??" && !isRunnerEvidence(item.path))) {
    const result = await processRunner.run({ executable: "git", args: ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-index", "--", "/dev/null", entry.path], cwd });
    if (!result || ![0, 1].includes(result.code) || result.signal || result.timedOut || result.outputLimit) throw new Error(`git diff --no-index failed with exit ${result?.code ?? "unknown"}: ${String(result?.stderr ?? "")}`);
    untrackedPatches.push(Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ""));
  }
  const fullPatch = Buffer.concat([patch, ...untrackedPatches]);
  const diffFields = diffNames.toString("utf8").split("\0");
  if (diffFields.pop() !== "") throw new Error("Git diff --name-only -z output must end with NUL.");
  const committedPaths = diffFields.map((file) => validateRelativePath(file, { allowDirectoryPrefix: false }));
  const changedPaths = [...new Set([...committedPaths, ...entries.flatMap((entry) => [entry.path, ...(entry.originalPath ? [entry.originalPath] : [])])])].filter((file) => !isRunnerEvidence(file)).sort();
  if (changedPaths.length === 0 || fullPatch.length === 0) throw new Error("candidate lacks Git change evidence.");
  const ownershipViolations = findOwnershipViolations(changedPaths, contract.ownedPaths);
  const forbiddenViolations = changedPaths.filter((changed) => findOwnershipViolations([changed], contract.forbiddenPaths).length === 0);
  if (ownershipViolations.length || forbiddenViolations.length) throw new Error(`ownership violation: ${[...new Set([...ownershipViolations, ...forbiddenViolations])].join(", ")}`);
  const pathHashes = {};
  for (const changed of changedPaths) {
    const file = path.join(cwd, ...changed.split("/"));
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (stat?.isSymbolicLink()) throw new Error(`changed path must not be a symlink: ${changed}`);
    pathHashes[changed] = stat?.isFile() ? sha256(fs.readFileSync(file)) : absentPathHash(changed);
  }
  const candidateHash = sha256(JSON.stringify({ headSha, branch, patch: fullPatch.toString("base64"), pathHashes }));
  return Object.freeze({ headSha, branch, status, patch: fullPatch, entries, changedPaths, pathHashes: Object.freeze(pathHashes), candidateHash });
}

function workerPrompt(contract, resultPath, fix) {
  return [
    `Immutable approved ticket ${contract.ticketId}.`,
    `Approved worktree: ${contract.worktreePath}`,
    `Approved base: ${contract.baseSha}`,
    `Context:\n${contract.context}`,
    `Ticket:\n${contract.ticket}`,
    `Owned paths: ${contract.ownedPaths.join(", ") || "none"}.`,
    `Forbidden paths: ${contract.forbiddenPaths.join(", ") || "none"}.`,
    fix ? `Apply only accepted findings:\n${JSON.stringify(fix)}` : "Implement approved scope only.",
    `Write JSON result to ${resultPath} with mode 0600: {"version":1,"status":"done|blocked","summary":"..."}.`,
    "Result file is sole completion protocol. Do not claim completion without writing it.",
  ].join("\n\n");
}

function reviewerPrompt(contract, candidate, resultPath, resultNonce, patchPath, patchSha256, validationLogPath) {
  return [
    `Fresh read-only review for ${contract.ticketId}. Do not edit files.`,
    `Approved worktree: ${contract.worktreePath}`,
    `Approved base: ${contract.baseSha}`,
    `Context:\n${contract.context}`,
    `Ticket:\n${contract.ticket}`,
    `Frozen candidate SHA-256: ${candidate.candidateHash}`,
    `Frozen patch: ${patchPath}`,
    `Frozen patch SHA-256: ${patchSha256}`,
    `Passing validation log: ${validationLogPath}`,
    `Changed paths: ${candidate.changedPaths.join(", ") || "none"}`,
    "Use only read, grep, find, and ls tools.",
    `Call ${REVIEW_RESULT_TOOL} exactly once with nonce ${resultNonce} and: {"verdict":"ok|needs_fix|blocked","findings":[{"severity":"P0|P1|P2","location":"...","problem":"...","action":"..."}],"summary":"...","candidateHash":"${candidate.candidateHash}"}.`,
    `The scoped tool writes only ${resultPath} with mode 0600. Do not use generic write, edit, or bash.`,
    "Result file is sole completion protocol.",
  ].join("\n\n");
}

function protocol(herdr) {
  const selected = herdr.extractionVerdict ?? herdr.resultProtocol ?? EXTRACTION_VERDICT;
  if (selected !== RESULT_PROTOCOL) throw new Error(`unsupported Herdr extraction protocol: ${String(selected)}.`);
}

export function createDeliveryRunner({ herdr, processRunner = createProcessRunner(), clock = () => new Date(), random = () => Math.random().toString(16).slice(2), notifier = async () => {}, beforeManifestPublish = async () => {}, beforeManifestOpen, afterManifestCreate } = {}) {
  if (!herdr || typeof herdr !== "object") throw new TypeError("herdr adapter is required.");
  if (!processRunner || typeof processRunner.run !== "function") throw new TypeError("processRunner.run is required.");
  if (typeof clock !== "function" || typeof random !== "function" || typeof notifier !== "function" || typeof beforeManifestPublish !== "function" || (beforeManifestOpen !== undefined && typeof beforeManifestOpen !== "function") || (afterManifestCreate !== undefined && typeof afterManifestCreate !== "function")) throw new TypeError("runner hooks must be functions.");

  async function runTicket(input) {
    const contract = validateTicketRunContract(input);
    const runDirectory = path.join(contract.repositoryPath, ".scratch", "delivery", contract.runId, contract.ticketId);
    fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(runDirectory, 0o700);
    const statePath = path.join(runDirectory, "state.json");
    const writeState = (state) => atomicWriteJson(statePath, { version: 1, runId: contract.runId, ticketId: contract.ticketId, updatedAt: clock().toISOString(), ...state });
    const finishBlocked = (reason, evidence = {}) => {
      writeState({ phase: "blocked", reason });
      return blocked(contract, reason, evidence);
    };
    try {
      protocol(herdr);
      await herdr.status();
      const setup = await herdr.worktreeCreate({ cwd: contract.repositoryPath, branch: contract.branch, base: contract.baseSha, path: contract.worktreePath, label: contract.ticketId, focus: false });
      if (!setup?.path || path.resolve(setup.path) !== contract.worktreePath || setup.pane !== contract.worker.pane) throw new Error("Herdr worktree path or pane did not match approved contract.");
      const workerTarget = `${contract.worker.name}-${contract.runId}`;
      await herdr.agentStart({ name: workerTarget, kind: contract.worker.kind, pane: contract.worker.pane, timeout: contract.agentTimeoutMs, agentArgs: ["--model", contract.worker.model] });
      let findings;
      let candidate;
      let validationLogPath;
      for (let round = 0; round <= contract.maxFixRounds; round += 1) {
        const nonce = text(String(random()), "random value", 256).replace(/[^A-Za-z0-9._-]/g, "_");
        const workerResultPath = path.join(runDirectory, `worker-${round}-${nonce}.json`);
        const workerPromptPath = path.join(runDirectory, `worker-${round}-${nonce}.prompt`);
        requireAbsent(workerResultPath, "worker result");
        const prompt = workerPrompt(contract, workerResultPath, findings);
        const promptSha256 = exclusiveWrite(workerPromptPath, prompt);
        writeState({ phase: "worker_waiting", round, target: workerTarget, resultPath: workerResultPath, promptPath: workerPromptPath, promptSha256 });
        await herdr.agentPrompt({ target: workerTarget, prompt: `Read prompt file ${workerPromptPath} (SHA-256 ${promptSha256}) and follow it exactly.`, wait: true, until: ["done", "blocked"], timeout: contract.agentTimeoutMs });
        const workerResult = readResult(runDirectory, workerResultPath, "worker");
        if (workerResult.status === "blocked") return finishBlocked("worker blocked", { workerResult });
        const preGate = await captureGit(processRunner, contract);
        validationLogPath = path.join(runDirectory, `validation-${round}.log`);
        const gate = await processRunner.run({ ...contract.validation, cwd: contract.validation.cwd ? path.join(contract.worktreePath, contract.validation.cwd) : contract.worktreePath });
        const gateLog = Buffer.concat([Buffer.from(gate.stdout ?? ""), Buffer.from(gate.stderr ?? "")]);
        const validationLogSha256 = exclusiveWrite(validationLogPath, gateLog);
        if (gate.code !== 0 || gate.signal || gate.timedOut || gate.outputLimit) return finishBlocked("validation failed", { exitCode: gate.code, signal: gate.signal ?? null, timedOut: gate.timedOut === true, outputLimit: gate.outputLimit === true, validationLog: validationLogPath });
        const postGate = await captureGit(processRunner, contract);
        if (postGate.candidateHash !== preGate.candidateHash) return finishBlocked("candidate drifted during validation", { expected: preGate.candidateHash, actual: postGate.candidateHash, validationLog: validationLogPath });
        candidate = postGate;
        const patchPath = path.join(runDirectory, `candidate-${round}.patch`);
        const patchSha256 = exclusiveWrite(patchPath, candidate.patch);
        const reviewerNonce = text(String(random()), "random value", 256).replace(/[^A-Za-z0-9._-]/g, "_");
        if (reviewerNonce === nonce) throw new Error("reviewer nonce must differ from worker nonce.");
        const reviewerTarget = `${contract.reviewer.name}-${contract.runId}-${round}-${reviewerNonce}`;
        const reviewerResultPath = path.join(runDirectory, `review-${round}-${reviewerNonce}.json`);
        const reviewerPromptPath = path.join(runDirectory, `review-${round}-${reviewerNonce}.prompt`);
        requireAbsent(reviewerResultPath, "review result");
        const reviewPrompt = reviewerPrompt(contract, candidate, reviewerResultPath, reviewerNonce, patchPath, patchSha256, validationLogPath);
        const reviewPromptSha256 = exclusiveWrite(reviewerPromptPath, reviewPrompt);
        writeState({ phase: "review_waiting", round, target: reviewerTarget, resultPath: reviewerResultPath, promptPath: reviewerPromptPath, promptSha256: reviewPromptSha256, candidateHash: candidate.candidateHash, patchPath, patchSha256, validationLogPath, validationLogSha256 });
        await herdr.agentStart({ name: reviewerTarget, kind: contract.reviewer.kind, pane: contract.reviewer.pane, timeout: contract.agentTimeoutMs, agentArgs: ["--model", contract.reviewer.model, "--extension", REVIEW_EXTENSION, "--delivery-result-path", reviewerResultPath, "--delivery-result-nonce", reviewerNonce, "--tools", [...REVIEW_TOOLS, REVIEW_RESULT_TOOL].join(",")] });
        await herdr.agentPrompt({ target: reviewerTarget, prompt: `Read prompt file ${reviewerPromptPath} (SHA-256 ${reviewPromptSha256}) and follow it exactly.`, wait: true, until: ["done", "blocked"], timeout: contract.agentTimeoutMs });
        const review = readResult(runDirectory, reviewerResultPath, "review");
        if (review.candidateHash !== candidate.candidateHash) return finishBlocked("review did not bind frozen candidate", { review });
        const afterReview = await captureGit(processRunner, contract);
        if (afterReview.candidateHash !== candidate.candidateHash) return finishBlocked("candidate drifted during review", { expected: candidate.candidateHash, actual: afterReview.candidateHash });
        if (review.verdict === "blocked") return finishBlocked("review blocked", { review });
        if (review.verdict === "ok") {
          const relative = (file) => validateRelativePath(path.relative(contract.repositoryPath, file).split(path.sep).join("/"), { allowDirectoryPrefix: false });
          const manifest = createHandoffManifest({
            ticketId: contract.ticketId,
            baseSha: contract.baseSha,
            headSha: candidate.headSha,
            branch: candidate.branch,
            worktreePath: contract.worktreePath,
            changedPaths: candidate.changedPaths,
            pathHashes: candidate.pathHashes,
            patchPath: relative(patchPath),
            patchSha256,
            artifactMappings: contract.artifactMappings,
            validationLog: relative(validationLogPath),
            agent: { name: workerTarget, paneId: contract.worker.pane, kind: contract.worker.kind, session: contract.worker.session },
          });
          const manifestPath = path.join(runDirectory, "handoff.json");
          let published;
          try {
            await beforeManifestPublish({ manifest, manifestPath });
            const finalCandidate = await captureGit(processRunner, contract);
            const finalReview = readResult(runDirectory, reviewerResultPath, "review");
            const finalPatch = safeFile(runDirectory, patchPath, "candidate patch");
            const finalValidation = safeFile(runDirectory, validationLogPath, "validation log");
            if (finalCandidate.candidateHash !== candidate.candidateHash || finalReview.sha256 !== review.sha256 || finalReview.candidateHash !== candidate.candidateHash || !finalPatch.equals(candidate.patch) || sha256(finalPatch) !== patchSha256 || sha256(finalValidation) !== validationLogSha256) throw new Error("completion evidence changed before manifest publication.");
            published = publishManifest(runDirectory, manifestPath, manifest, { beforeOpen: beforeManifestOpen, afterCreate: afterManifestCreate });
          } catch (error) { return finishBlocked(error instanceof Error ? error.message : String(error)); }
          const result = Object.freeze({ ticketId: contract.ticketId, status: "done", candidateHash: candidate.candidateHash, manifest: published.manifest, manifestPath });
          writeState({ phase: "done", round, target: reviewerTarget, resultPath: reviewerResultPath, resultSha256: review.sha256, candidateHash: candidate.candidateHash, patchPath, patchSha256, validationLogPath, validationLogSha256, manifestPath, manifestSha256: published.sha256 });
          await notifier({ title: `${contract.ticketId} done`, body: manifestPath, sound: "done" });
          return result;
        }
        if (round === contract.maxFixRounds) return finishBlocked("fix-round limit reached", { review });
        findings = review.findings;
        writeState({ phase: "needs_fix", round, target: workerTarget, findings, candidateHash: candidate.candidateHash });
      }
      throw new Error("unreachable ticket loop state.");
    } catch (error) {
      writeState({ phase: "blocked", reason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async function recoverSettledResult(input, { expectedTarget, expectedKind, expectedCandidateHash, finalizeDone = false, beforeManifestPublish } = {}) {
    const contract = validateTicketRunContract(input);
    const runDirectory = path.join(contract.repositoryPath, ".scratch", "delivery", contract.runId, contract.ticketId);
    const statePath = path.join(runDirectory, "state.json");
    const stop = (reason, evidence = {}) => {
      fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
      atomicWriteJson(statePath, { version: 1, runId: contract.runId, ticketId: contract.ticketId, updatedAt: clock().toISOString(), phase: "blocked", reason });
      return blocked(contract, reason, evidence);
    };
    let state;
    try { state = readJson(statePath); } catch { return stop("recovery state is missing or ambiguous"); }
    const originalDone = state?.phase === "done";
    const reject = (reason, evidence = {}) => originalDone ? blocked(contract, reason, evidence) : stop(reason, evidence);
    try { protocol(herdr); } catch (error) { if (originalDone) return reject(error instanceof Error ? error.message : String(error)); stop(error instanceof Error ? error.message : String(error)); throw error; }
    if (!state || state.version !== 1 || state.runId !== contract.runId || state.ticketId !== contract.ticketId || !["worker_waiting", "review_waiting", "done"].includes(state.phase) || typeof state.target !== "string" || typeof state.resultPath !== "string") return reject("recovery state is ambiguous");
    const kind = state.phase === "worker_waiting" ? "worker" : "review";
    if (state.phase !== "done") {
      if (typeof state.promptPath !== "string" || !/^[0-9a-f]{64}$/.test(state.promptSha256 ?? "")) return reject("recovery state is ambiguous");
      let promptBytes;
      try { promptBytes = safeFile(runDirectory, state.promptPath, "recovery prompt"); } catch { return reject("recovery prompt is missing or ambiguous"); }
      if (sha256(promptBytes) !== state.promptSha256) return reject("recovery prompt digest is ambiguous");
    }
    if ((expectedTarget && state.target !== expectedTarget) || (expectedKind && kind !== expectedKind) || (expectedCandidateHash && state.candidateHash !== expectedCandidateHash)) return reject("recovery identity is ambiguous");
    if (state.phase !== "done") {
      let agentState;
      try { agentState = await herdr.agentGet(state.target); } catch (error) { stop(error instanceof Error ? error.message : String(error)); throw error; }
      const settled = agentState?.agent?.status ?? agentState?.agent?.state ?? agentState?.status ?? agentState?.state;
      if (!["done", "blocked", "idle"].includes(settled)) return reject("recovery agent is not settled", { target: state.target, agentState });
    }
    let result;
    try { result = readResult(runDirectory, state.resultPath, kind); } catch { return reject("recovery result is missing or ambiguous", { target: state.target }); }
    if (kind === "review" && (typeof state.candidateHash !== "string" || result.candidateHash !== state.candidateHash)) return reject("recovery candidate hash is ambiguous", { target: state.target });
    if (state.phase === "done" && result.sha256 !== state.resultSha256) return reject("recovery review result digest is ambiguous", { target: state.target });
    if (!finalizeDone && state.phase !== "done") {
      atomicWriteJson(statePath, { version: 1, runId: contract.runId, ticketId: contract.ticketId, updatedAt: clock().toISOString(), phase: "recovered", target: state.target, kind, resultSha256: result.sha256, ...(state.candidateHash ? { candidateHash: state.candidateHash } : {}) });
      return Object.freeze({ ticketId: contract.ticketId, status: "recovered", target: state.target, kind, result });
    }
    if (kind === "review" && result.verdict === "ok") {
      let candidate;
      try { candidate = await captureGit(processRunner, contract); } catch { return reject("recovery candidate Git evidence is ambiguous", { target: state.target }); }
      if (candidate.candidateHash !== state.candidateHash) return reject("recovery candidate hash is ambiguous", { target: state.target });
      if (!Number.isSafeInteger(state.round) || state.round < 0) return reject("recovery evidence paths are ambiguous", { target: state.target });
      const expectedPatchPath = path.join(runDirectory, `candidate-${state.round}.patch`);
      const expectedValidationLogPath = path.join(runDirectory, `validation-${state.round}.log`);
      if (state.patchPath !== expectedPatchPath || state.validationLogPath !== expectedValidationLogPath || !/^[0-9a-f]{64}$/.test(state.patchSha256 ?? "") || !/^[0-9a-f]{64}$/.test(state.validationLogSha256 ?? "")) return reject("recovery evidence paths or digests are ambiguous", { target: state.target });
      const patchPath = state.patchPath; const validationLogPath = state.validationLogPath;
      let patchBytes; let validationLogBytes;
      try { patchBytes = safeFile(runDirectory, patchPath, "recovery patch"); validationLogBytes = safeFile(runDirectory, validationLogPath, "recovery validation log"); } catch { return reject("recovery evidence is missing or ambiguous", { target: state.target }); }
      const patchSha256 = sha256(patchBytes); const validationLogSha256 = sha256(validationLogBytes);
      if (!patchBytes.equals(candidate.patch) || patchSha256 !== state.patchSha256) return reject("recovery patch is missing or ambiguous", { target: state.target });
      if (validationLogSha256 !== state.validationLogSha256) return reject("recovery validation evidence is ambiguous", { target: state.target });
      const relative = (file) => validateRelativePath(path.relative(contract.repositoryPath, file).split(path.sep).join("/"), { allowDirectoryPrefix: false });
      const expectedManifest = createHandoffManifest({ ticketId: contract.ticketId, baseSha: contract.baseSha, headSha: candidate.headSha, branch: candidate.branch, worktreePath: contract.worktreePath, changedPaths: candidate.changedPaths, pathHashes: candidate.pathHashes, patchPath: relative(patchPath), patchSha256, artifactMappings: contract.artifactMappings, validationLog: relative(validationLogPath), agent: { name: `${contract.worker.name}-${contract.runId}`, paneId: contract.worker.pane, kind: contract.worker.kind, session: contract.worker.session } });
      const expectedManifestPath = path.join(runDirectory, "handoff.json");
      const manifestPath = state.phase === "done" ? state.manifestPath : expectedManifestPath;
      if (state.phase === "done") {
        if (manifestPath !== expectedManifestPath || !/^[0-9a-f]{64}$/.test(state.manifestSha256 ?? "")) return reject("recovery manifest path or digest is ambiguous", { target: state.target });
        let manifestBytes; let manifest; let rawManifest;
        try { manifestBytes = safeFile(runDirectory, manifestPath, "recovery manifest"); rawManifest = JSON.parse(manifestBytes.toString("utf8")); manifest = createHandoffManifest(rawManifest); } catch { return reject("recovery manifest is missing or ambiguous", { target: state.target }); }
        if (sha256(manifestBytes) !== state.manifestSha256 || JSON.stringify(rawManifest) !== JSON.stringify(expectedManifest) || JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) return reject("recovery manifest digest or schema is ambiguous", { target: state.target });
        return Object.freeze({ ticketId: contract.ticketId, status: "done", candidateHash: candidate.candidateHash, manifest, manifestPath });
      }
      if (beforeManifestPublish !== undefined) {
        if (typeof beforeManifestPublish !== "function") return blocked(contract, "recovery publication hook is invalid", { target: state.target });
        await beforeManifestPublish();
      }
      let finalCandidate; let finalResult; let finalPatch; let finalValidation;
      try {
        finalCandidate = await captureGit(processRunner, contract);
        finalResult = readResult(runDirectory, state.resultPath, "review");
        finalPatch = safeFile(runDirectory, patchPath, "recovery patch");
        finalValidation = safeFile(runDirectory, validationLogPath, "recovery validation log");
      } catch { return blocked(contract, "recovery evidence changed before publish", { target: state.target }); }
      if (finalCandidate.candidateHash !== state.candidateHash || finalResult.sha256 !== result.sha256 || finalResult.candidateHash !== state.candidateHash || !finalPatch.equals(patchBytes) || sha256(finalPatch) !== state.patchSha256 || !finalValidation.equals(validationLogBytes) || sha256(finalValidation) !== state.validationLogSha256) return blocked(contract, "recovery evidence changed before publish", { target: state.target });
      const finalManifest = createHandoffManifest({ ticketId: contract.ticketId, baseSha: contract.baseSha, headSha: finalCandidate.headSha, branch: finalCandidate.branch, worktreePath: contract.worktreePath, changedPaths: finalCandidate.changedPaths, pathHashes: finalCandidate.pathHashes, patchPath: relative(patchPath), patchSha256: state.patchSha256, artifactMappings: contract.artifactMappings, validationLog: relative(validationLogPath), agent: { name: `${contract.worker.name}-${contract.runId}`, paneId: contract.worker.pane, kind: contract.worker.kind, session: contract.worker.session } });
      if (JSON.stringify(finalManifest) !== JSON.stringify(expectedManifest)) return blocked(contract, "recovery manifest binding changed before publish", { target: state.target });
      let published;
      try { published = publishManifest(runDirectory, manifestPath, expectedManifest); } catch { return blocked(contract, "recovery published manifest conflicts with evidence", { target: state.target }); }
      atomicWriteJson(statePath, { version: 1, runId: contract.runId, ticketId: contract.ticketId, updatedAt: clock().toISOString(), phase: "done", round: state.round, target: state.target, resultPath: state.resultPath, resultSha256: finalResult.sha256, candidateHash: state.candidateHash, patchPath, patchSha256: state.patchSha256, validationLogPath, validationLogSha256: state.validationLogSha256, manifestPath, manifestSha256: published.sha256 });
      return Object.freeze({ ticketId: contract.ticketId, status: "done", candidateHash: finalCandidate.candidateHash, manifest: published.manifest, manifestPath });
    }
    return stop(kind === "worker" ? "settled worker recovery cannot start a replacement reviewer" : `recovered review verdict requires operator resolution: ${result.verdict}`, { target: state.target, result });
  }

  return Object.freeze({ runTicket, recoverSettledResult });
}

function blocked(contract, reason, evidence) {
  return Object.freeze({ ticketId: contract.ticketId, status: "blocked", reason, evidence: Object.freeze(evidence) });
}

export { RESULT_PROTOCOL, REVIEW_TOOLS };
