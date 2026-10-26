import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { createDeliveryRunner, createProcessRunner, REVIEW_TOOLS, validateTicketRunContract } from "./delivery-runner.mjs";
import { buildChildEnvironment, createHerdrAdapter, HERDR_BASELINE_VERSION, HERDR_PROTOCOL } from "./lib/herdr.mjs";
import { createScheduler, reconcileRunner, validateTicketGraph } from "./lib/scheduler.mjs";
import { validateCommandSpec } from "./lib/contracts.mjs";
import { acquireRunnerLock, atomicWriteJson, readJson, readSecureJson, releaseRunnerLock, writeExclusiveJson } from "./lib/state.mjs";

export const REVIEWER_MODEL = "9router/cc/claude-opus-5-5";
export const WORKER_MODEL = "9router/cx/gpt-5.6-sol";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = fileURLToPath(import.meta.url);
const MAX_FILE_BYTES = 128 * 1024;
const LEGACY_PATHS = [".scratch/pi-subagents", ".pi/subagents"];
const queues = new Map();
const REVIEW_RESULT_TOOL = "delivery_result_write";
const REVIEW_EXTENSION = path.join(ROOT, "reviewer-result-tool.ts");
const SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function contractDigest(value) { return createHash("sha256").update(canonical(value)).digest("hex"); }
function processResult(output, executable, args) {
  if (!output || output.code !== 0 || output.signal || output.timedOut || output.outputLimit) throw new Error(`${executable} ${args.join(" ")} failed.`);
  return Buffer.isBuffer(output.stdout) ? output.stdout.toString("utf8") : String(output.stdout ?? "");
}
async function command(runner, executable, args, cwd) { return processResult(await runner.run({ executable, args, cwd }), executable, args); }

function canonicalFuture(file) {
  let current = path.parse(path.resolve(file)).root;
  for (const component of path.resolve(file).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("path components must be real directories without symlinks or special files.");
  }
  let existing = path.resolve(file); const suffix = [];
  while (!fs.existsSync(existing)) { suffix.unshift(path.basename(existing)); existing = path.dirname(existing); }
  return path.join(fs.realpathSync(existing), ...suffix);
}
function directoryIdentity(directory) { const stat = fs.lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("worktreeRoot must be a real directory."); return Object.freeze({ path: fs.realpathSync(directory), dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid }); }
function beneath(root, child) { const relative = path.relative(root, child); return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); }

async function preflight(repositoryPath, input, graph, validation, herdr, processRunner) {
  if (process.env.HERDR_ENV !== "1") throw new Error("HERDR_ENV=1 is required.");
  const status = await herdr.status();
  if (status.client?.version !== HERDR_BASELINE_VERSION || status.server?.version !== HERDR_BASELINE_VERSION || status.client?.protocol !== HERDR_PROTOCOL || status.server?.protocol !== HERDR_PROTOCOL) throw new Error("Herdr preflight version or protocol mismatch.");
  const integrations = await herdr.integrationStatus();
  if (!integrations.some((entry) => entry.name === "pi" && entry.status === "current (v9)")) throw new Error("Herdr pi integration is not approved current (v9).");
  const root = fs.realpathSync(repositoryPath);
  const top = (await command(processRunner, "git", ["rev-parse", "--show-toplevel"], root)).trim();
  if (fs.realpathSync(top) !== root) throw new Error("repositoryPath is not parent checkout root.");
  const identity = (await command(processRunner, "git", ["rev-parse", "--git-common-dir"], root)).trim();
  if ((await command(processRunner, "git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], root)).length) throw new Error("parent checkout must be clean.");
  const baseSha = (await command(processRunner, "git", ["rev-parse", "--verify", `${input.baseSha}^{commit}`], root)).trim();
  if (!SHA.test(baseSha)) throw new Error("base ref did not resolve to immutable commit SHA.");
  await command(processRunner, "git", ["merge-base", "--is-ancestor", baseSha, "HEAD"], root);
  await command(processRunner, "git", ["check-ignore", "-q", ".scratch/"], root);
  if (typeof input.worktreeRoot !== "string" || !path.isAbsolute(input.worktreeRoot) || input.worktreeRoot.length > 4096 || path.normalize(input.worktreeRoot) !== input.worktreeRoot) throw new TypeError("worktreeRoot must be a bounded normalized absolute path.");
  const futureRoot = canonicalFuture(input.worktreeRoot); if (futureRoot !== input.worktreeRoot) throw new Error("worktreeRoot must already be canonical without symlink aliases."); fs.mkdirSync(futureRoot, { recursive: true, mode: 0o700 }); fs.chmodSync(futureRoot, 0o700);
  const rootIdentity = directoryIdentity(futureRoot); const worktreeRoot = rootIdentity.path; fs.accessSync(worktreeRoot, fs.constants.W_OK);
  for (const ticket of graph) { const canonicalTicket = canonicalFuture(ticket.worktreePath); if (canonicalTicket !== ticket.worktreePath || !beneath(worktreeRoot, canonicalTicket) || ticket.worktreePath === worktreeRoot) throw new Error(`${ticket.id}.worktreePath must be canonical and strictly beneath worktreeRoot.`); }
  return Object.freeze({ repositoryRoot: root, gitCommonDir: path.resolve(root, identity), baseSha, worktreeRoot, worktreeRootIdentity: rootIdentity, herdrClient: status.client.version, herdrServer: status.server.version, protocol: status.client.protocol, piIntegration: "current (v9)", scratchIgnored: true, worktreeRootsSafe: true, validation });
}

function safeId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new TypeError(`${label} must be 1–128 safe characters.`);
  return value;
}
function runtimePath(repositoryPath, runId) { return path.join(repositoryPath, ".scratch", "delivery", safeId(runId, "runId")); }
function regularTextFile(repositoryPath, relative, label) {
  if (typeof relative !== "string" || !relative.startsWith(".scratch/") || relative.includes("\0")) throw new TypeError(`${label} must be a .scratch/ path.`);
  const root = fs.realpathSync(repositoryPath); const requested = path.resolve(root, relative); const stat = fs.lstatSync(requested); const real = fs.realpathSync(requested); const rel = path.relative(root, real);
  if (!stat.isFile() || stat.isSymbolicLink() || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || stat.size > MAX_FILE_BYTES) throw new TypeError(`${label} must be a bounded regular file inside repository.`);
  return fs.readFileSync(real, "utf8");
}
function result(text, details, isError = false) { return { content: [{ type: "text", text }], details, ...(isError ? { isError: true } : {}) }; }
function state(repositoryPath, runId) { return readJson(path.join(runtimePath(repositoryPath, runId), "state.json")); }
function legacy(repositoryPath) { return LEGACY_PATHS.filter((entry) => fs.existsSync(path.join(repositoryPath, entry))); }
function requestId(action) { return `${action}-${Date.now()}-${Math.random().toString(16).slice(2)}`; }

export function createDeliveryWorkflowCore({ spawnProcess = spawn, now = () => new Date(), random = () => Math.random().toString(16).slice(2), processInbox, processRunner = createProcessRunner({ env: buildChildEnvironment() }), herdr = createHerdrAdapter({ env: buildChildEnvironment() }), ownershipToken = () => randomBytes(32).toString("hex"), awaitHandshake } = {}) {
  const launch = async (args, repositoryPath, handshake) => {
    const token = ownershipToken(); if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("runner ownership token must be 256-bit hex.");
    const child = spawnProcess(process.execPath, [ENTRY, ...args], { cwd: repositoryPath, env: { ...buildChildEnvironment(), DELIVERY_WORKFLOW_PACKAGE_ROOT: ROOT, ...(handshake ? { DELIVERY_RUNNER_TOKEN: token, DELIVERY_RUNNER_DIGEST: handshake.digest } : {}) }, detached: true, shell: false, stdio: "ignore" });
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error("detached runner PID is unavailable.");
    child.unref();
    if (handshake) {
      if (awaitHandshake) await awaitHandshake({ child, token, ...handshake });
      const deadline = Date.now() + 5_000; let handshakeAccepted = false;
      while (Date.now() < deadline) { try { const record = readSecureJson(path.join(handshake.runtimeDir, "runner.json")); const beat = readSecureJson(path.join(handshake.runtimeDir, "heartbeat.json")); const updated = new Date(beat.updatedAt); const fresh = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(beat.updatedAt ?? "") && Number.isFinite(updated.valueOf()) && updated.toISOString() === beat.updatedAt && Date.now() - updated.valueOf() >= 0 && Date.now() - updated.valueOf() <= 5_000; handshakeAccepted = record?.pid === child.pid && record?.ownershipToken === token && record?.contractDigest === handshake.digest && beat?.pid === child.pid && beat?.ownershipToken === token && beat?.contractDigest === handshake.digest && Number.isSafeInteger(beat.sequence) && beat.sequence > 0 && fresh; if (handshakeAccepted) break; } catch {} await new Promise((resolve) => setTimeout(resolve, 20)); }
      if (!handshakeAccepted) {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
        let childClosed = false; child.once?.("close", () => { childClosed = true; }); const deadline = Date.now() + 2_000; let groupGone = false;
        while (Date.now() < deadline && (!childClosed || !groupGone)) { try { process.kill(-child.pid, 0); groupGone = false; } catch (error) { if (error.code === "ESRCH") groupGone = true; } await new Promise((resolve) => setTimeout(resolve, 25)); }
        const confirmed = childClosed && groupGone; atomicWriteJson(path.join(handshake.runtimeDir, "launch-blocked.json"), { version: 1, pid: child.pid, status: confirmed ? "blocked" : "stop_unconfirmed", childClosed, groupGone, reason: confirmed ? "detached runner ownership handshake failed after confirmed exit" : "detached runner ownership handshake failed and shutdown is unconfirmed", createdAt: now().toISOString() });
        throw new Error(confirmed ? "detached runner ownership handshake failed after confirmed exit." : "detached runner ownership handshake failed; stop unconfirmed.");
      }
    }
    return { pid: child.pid };
  };
  const enqueue = (key, work) => {
    const pending = (queues.get(key) ?? Promise.resolve()).then(work);
    queues.set(key, pending.then(() => undefined, () => undefined));
    return pending;
  };
  const control = async (repositoryPath, input, action) => {
    const runId = safeId(input.runId, "runId"); const dir = runtimePath(repositoryPath, runId); const old = legacy(repositoryPath); const statePath = path.join(dir, "state.json");
    if (!fs.existsSync(statePath) && old.length) return result(`Legacy pi-subagents runtime is unsupported for ${action}. Start a new delivery run.`, { status: "unsupported", legacyPaths: old }, true);
    if (!fs.existsSync(statePath)) return result(`Run ${runId} not found; ${action} was not queued.`, { status: "not_found", runId, action }, true);
    const request = { version: 1, requestId: requestId(action), runId, action, ...(input.ticketId ? { ticketId: input.ticketId } : {}), ...(input.message ? { message: input.message } : {}), ...(input.integratedSha ? { integratedSha: input.integratedSha } : {}), createdAt: now().toISOString() };
    const inbox = path.join(dir, "inbox"); fs.mkdirSync(inbox, { recursive: true, mode: 0o700 });
    atomicWriteJson(path.join(inbox, `${request.requestId}.json`), request);
    if (processInbox) await enqueue(dir, () => processInbox(dir));
    return result(`${action} queued for ${runId}.`, { status: "queued", runId, requestId: request.requestId, action });
  };
  return Object.freeze({
    async review(repositoryPath, input) {
      const runId = safeId(input.runId, "runId"); regularTextFile(repositoryPath, input.artifact, "artifact"); regularTextFile(repositoryPath, input.contextBundle, "contextBundle");
      const dir = runtimePath(repositoryPath, runId); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const request = { version: 1, runId, kind: input.kind, artifact: input.artifact, contextBundle: input.contextBundle, focus: input.focus ?? "", createdAt: now().toISOString() };
      const requestPath = path.join(dir, `review-${random()}.json`); atomicWriteJson(requestPath, request); const launched = await launch(["review", requestPath], repositoryPath);
      return result(`Fresh ${input.kind} review launched for ${runId}.`, { status: "launched", runId, pid: launched.pid, requestPath, model: REVIEWER_MODEL, tools: REVIEW_TOOLS });
    },
    async start(repositoryPath, input) {
      const runId = safeId(input.runId, "runId"); const dir = runtimePath(repositoryPath, runId);
      const tickets = JSON.parse(input.tickets);
      const graph = validateTicketGraph(tickets); const validation = validateCommandSpec(input.validation);
      const proposed = { version: 1, runId, repositoryPath, worktreeRoot: input.worktreeRoot, baseSha: input.baseSha, tickets: graph, validation, ...(input.maxConcurrency === undefined ? {} : { maxConcurrency: input.maxConcurrency }) };
      const evidence = await preflight(repositoryPath, input, graph, validation, herdr, processRunner);
      const normalized = { ...proposed, repositoryPath: evidence.repositoryRoot, worktreeRoot: evidence.worktreeRoot, worktreeRootIdentity: evidence.worktreeRootIdentity, baseSha: evidence.baseSha };
      for (const ticket of graph) validateTicketRunContract(ticketContract(normalized, ticket));
      const config = normalized; const immutableDigest = contractDigest(config);
      fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
      try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code === "EEXIST") return result(`Run ${runId} already exists.`, { status: "exists", runId }, true); throw error; }
      writeExclusiveJson(path.join(dir, "config.json"), config);
      writeExclusiveJson(path.join(dir, "run.json"), { version: 1, config, baseSha: evidence.baseSha, contractDigest: immutableDigest, repository: { path: evidence.repositoryRoot, gitCommonDir: evidence.gitCommonDir }, preflight: evidence, createdAt: now().toISOString() });
      atomicWriteJson(path.join(dir, "state.json"), { version: 1, runId, baseSha: evidence.baseSha, phase: "ready", tickets: Object.fromEntries(config.tickets.map((ticket) => [ticket.id, { status: "ready", attempt: 0 }])), completedSteps: [], nextAction: "start dependency-ready batch", updatedAt: now().toISOString() });
      const launched = await launch(["run", dir], repositoryPath, { runtimeDir: dir, digest: immutableDigest });
      return result(`Delivery run ${runId} launched.`, { status: "launched", runId, pid: launched.pid, runtimeDir: dir });
    },
    async status(repositoryPath, input) {
      const old = legacy(repositoryPath); const file = path.join(runtimePath(repositoryPath, input.runId), "state.json");
      if (!fs.existsSync(file)) return old.length ? result("Legacy pi-subagents runtime detected; control and continuation are unsupported. Start a new delivery run.", { status: "unsupported", legacyPaths: old }) : result(`Run ${input.runId} not found.`, { status: "not_found", runId: input.runId }, true);
      const current = state(repositoryPath, input.runId); return result(`Run ${input.runId}: ${current.phase}. Next: ${current.nextAction}`, { status: "ok", state: current });
    },
    steer: (repositoryPath, input) => control(repositoryPath, input, "steer"),
    reply: (repositoryPath, input) => control(repositoryPath, input, "reply"),
    continue: (repositoryPath, input) => control(repositoryPath, input, "continue"),
    stop: (repositoryPath, input) => control(repositoryPath, input, "stop"),
  });
}

function reviewPaths(requestPath) {
  if (typeof requestPath !== "string" || !path.isAbsolute(requestPath) || path.normalize(requestPath) !== requestPath) throw new TypeError("review request path must be normalized and absolute.");
  const name = path.basename(requestPath); const match = name.match(/^(review-[A-Za-z0-9._-]+)\.json$/);
  if (!match) throw new TypeError("review request filename is invalid.");
  const directory = path.dirname(requestPath); const nonce = match[1];
  return { requestPath, directory, nonce, resultPath: path.join(directory, `${nonce}-result.json`), statusPath: path.join(directory, `${nonce}-status.json`) };
}
function writeReviewBlocked(statusPath, error) {
  const reason = (error instanceof Error ? error.message : String(error)).slice(0, 16_000) || "review failed";
  const temporary = `${statusPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600); fs.writeFileSync(fd, `${JSON.stringify({ version: 1, phase: "blocked", reason, updatedAt: new Date().toISOString() })}\n`); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.linkSync(temporary, statusPath);
  } catch (writeError) {
    if (writeError.code !== "EEXIST") throw writeError;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (unlinkError) { if (unlinkError.code !== "ENOENT") throw unlinkError; }
  }
}
function reviewResult(file, expectedHash) {
  const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) throw new Error("review result must be a regular 0600 file.");
  const bytes = fs.readFileSync(file); const value = JSON.parse(bytes.toString("utf8"));
  if (value.version !== 1 || !["ok", "needs_fix", "blocked"].includes(value.verdict) || !Array.isArray(value.findings) || value.findings.length > 12 || value.candidateHash !== expectedHash || typeof value.summary !== "string" || !value.summary || value.summary.length > 16_000) throw new Error("review result schema or candidate hash is invalid.");
  return { value, sha256: createHash("sha256").update(bytes).digest("hex") };
}
export async function runStandaloneReview(requestPath, options = {}) {
  const paths = reviewPaths(requestPath);
  try {
    const repositoryPath = options.cwd ?? process.cwd(); const request = readJson(paths.requestPath);
    const runId = safeId(request.runId, "runId"); const artifact = regularTextFile(repositoryPath, request.artifact, "artifact"); const context = regularTextFile(repositoryPath, request.contextBundle, "contextBundle");
    const herdr = options.herdr ?? createHerdrAdapter({ cwd: repositoryPath }); await herdr.status();
    const target = `delivery-review-${runId}-${paths.nonce}`; const candidateHash = createHash("sha256").update(artifact).digest("hex");
    const setup = await herdr.worktreeCreate({ cwd: repositoryPath, label: target, focus: false });
    if (!setup?.pane || !setup?.path) throw new Error("Herdr review workspace lacked pane or path.");
    await herdr.agentStart({ name: target, kind: "pi", pane: setup.pane, timeout: 300_000, agentArgs: ["--model", REVIEWER_MODEL, "--extension", REVIEW_EXTENSION, "--delivery-result-path", paths.resultPath, "--delivery-result-nonce", paths.nonce, "--tools", [...REVIEW_TOOLS, REVIEW_RESULT_TOOL].join(",")] });
    await herdr.agentPrompt({ target, wait: true, until: ["done", "blocked"], timeout: 300_000, prompt: `Fresh read-only ${request.kind} review. Do not edit files.\nContext:\n${context}\nArtifact:\n${artifact}\nFocus: ${request.focus || "all approved requirements"}\nCall ${REVIEW_RESULT_TOOL} once with nonce ${paths.nonce}, candidateHash ${candidateHash}, and bounded verdict/findings/summary. No generic write, edit, or bash.` });
    const checked = reviewResult(paths.resultPath, candidateHash); atomicWriteJson(paths.statusPath, { version: 1, status: "done", resultPath: paths.resultPath, resultSha256: checked.sha256, verdict: checked.value.verdict });
  } catch (error) {
    writeReviewBlocked(paths.statusPath, error); throw error;
  }
}
function ticketContract(config, ticket) {
  const { id, dependencies: _dependencies, batch: _batch, ownedFiles, ...contract } = ticket;
  return { ...contract, version: 1, runId: config.runId, ticketId: id, planApproved: true, repositoryPath: config.repositoryPath, worktreeRoot: config.worktreeRoot, worktreeRootIdentity: config.worktreeRootIdentity, baseSha: config.baseSha, ownedPaths: contract.ownedPaths ?? ownedFiles, validation: contract.validation ?? config.validation, worker: { ...contract.worker, model: WORKER_MODEL }, reviewer: { ...contract.reviewer, model: REVIEWER_MODEL } };
}
function processAlive(owner) {
  try { process.kill(owner.pid, 0); return true; } catch (error) { return error.code === "ESRCH" ? false : undefined; }
}
function heartbeatWriter(runtimeDir, owner, now = () => new Date()) {
  const file = path.join(runtimeDir, "heartbeat.json"); let sequence = 0;
  const beat = () => { let challenge; try { challenge = readSecureJson(path.join(runtimeDir, "heartbeat-challenge.json")).challenge; } catch {} atomicWriteJson(file, { version: 1, pid: owner.pid, ownershipToken: owner.ownershipToken, contractDigest: owner.contractDigest, sequence: ++sequence, ...(challenge ? { challenge } : {}), updatedAt: now().toISOString() }); };
  beat(); const timer = setInterval(beat, 1000); timer.unref(); return () => clearInterval(timer);
}
function heartbeatAlive(runtimeDir, owner, challenge) {
  try { const beat = readSecureJson(path.join(runtimeDir, "heartbeat.json")); const age = Date.now() - new Date(beat.updatedAt).valueOf(); return beat.version === 1 && beat.pid === owner.pid && beat.ownershipToken === owner.ownershipToken && beat.contractDigest === owner.contractDigest && (!challenge || beat.challenge === challenge) && Number.isSafeInteger(beat.sequence) && beat.sequence > 0 && age >= 0 && age <= 5000 && processAlive(owner) === true ? true : false; } catch { return undefined; }
}

function runContractDigest(runtimeDir) { return readSecureJson(path.join(runtimeDir, "run.json")).contractDigest; }
function verifiedRuntimeContract(runtimeDir) {
  const run = readSecureJson(path.join(runtimeDir, "run.json"));
  const config = readSecureJson(path.join(runtimeDir, "config.json"));
  if (!run || run.version !== 1 || !run.config || !SHA.test(run.baseSha ?? "") || !/^[0-9a-f]{64}$/.test(run.contractDigest ?? "")) throw new Error("run contract is invalid.");
  if (contractDigest(run.config) !== run.contractDigest || contractDigest(config) !== run.contractDigest || canonical(config) !== canonical(run.config)) throw new Error("run contract or config binding changed.");
  if (config.baseSha !== run.baseSha || config.repositoryPath !== run.repository?.path) throw new Error("run contract repository or base binding changed.");
  return config;
}
function blockRecovery(runtimeDir, reason) {
  const statePath = path.join(runtimeDir, "state.json");
  const current = readJson(statePath); const bounded = String(reason || "detached recovery is ambiguous").slice(0, 16_000);
  const active = new Set(["allocating", "active", "validating", "review", "needs_fix", "worker_waiting", "review_waiting"]);
  const tickets = Object.fromEntries(Object.entries(current.tickets).map(([id, ticket]) => [id, active.has(ticket.status) ? { ...ticket, status: "blocked", reason: bounded } : ticket]));
  atomicWriteJson(statePath, { ...current, phase: "blocked", tickets, nextAction: "inspect retained runner and Herdr evidence", reason: bounded, updatedAt: new Date().toISOString() });
}

export async function runDetachedDelivery(runtimeDir, options = {}) {
  const config = verifiedRuntimeContract(runtimeDir);
  let challengedAlive;
  if (!options.isProcessAlive && fs.existsSync(path.join(runtimeDir, "runner.json"))) { const challenge = randomBytes(32).toString("hex"); atomicWriteJson(path.join(runtimeDir, "heartbeat-challenge.json"), { version: 1, challenge, createdAt: new Date().toISOString() }); const deadline = Date.now() + 2500; let existing; try { existing = readSecureJson(path.join(runtimeDir, "runner.json")); } catch {} while (existing && Date.now() < deadline && heartbeatAlive(runtimeDir, existing, challenge) !== true) await new Promise((resolve) => setTimeout(resolve, 25)); challengedAlive = existing ? heartbeatAlive(runtimeDir, existing, challenge) : undefined; }
  const isProcessAlive = options.isProcessAlive ?? (() => challengedAlive);
  const token = options.runnerOwner?.ownershipToken ?? process.env.DELIVERY_RUNNER_TOKEN;
  const digestValue = options.runnerOwner?.contractDigest ?? process.env.DELIVERY_RUNNER_DIGEST;
  const owner = options.runnerOwner ?? { version: 1, pid: process.pid, ownershipToken: token, contractDigest: digestValue, runId: config.runId, createdAt: new Date().toISOString() };
  if (!/^[0-9a-f]{64}$/.test(owner.ownershipToken ?? "") || owner.contractDigest !== runContractDigest(runtimeDir)) throw new Error("runner ownership handshake context is invalid.");
  const reconciliation = reconcileRunner(runtimeDir, { isProcessAlive });
  if (reconciliation.status === "blocked") {
    if (reconciliation.reason !== "runner owner is live") blockRecovery(runtimeDir, reconciliation.reason);
    const error = new Error(reconciliation.reason); error.code = reconciliation.reason === "runner owner is live" ? "RUNNER_OWNED" : "RECOVERY_BLOCKED"; throw error;
  }
  const lockPath = path.join(runtimeDir, "runner.lock"); const runnerPath = path.join(runtimeDir, "runner.json");
  if (reconciliation.status === "stale") fs.renameSync(runnerPath, `${runnerPath}.stale-${Date.now()}`);
  try { acquireRunnerLock(lockPath, owner, { isOwnerAlive: isProcessAlive }); } catch (cause) {
    const error = new Error(`runner ownership claim failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }); error.code = "RUNNER_OWNED"; throw error;
  }
  writeExclusiveJson(runnerPath, owner); const stopHeartbeat = heartbeatWriter(runtimeDir, owner, options.now);
  const childEnv = buildChildEnvironment(); const processRunner = options.processRunner ?? createProcessRunner({ env: childEnv }); const herdr = options.herdr ?? createHerdrAdapter({ cwd: config.repositoryPath, env: childEnv }); const runner = options.runner ?? createDeliveryRunner({ herdr, processRunner, runDigest: runContractDigest(runtimeDir) });
  const scheduler = createScheduler({ repositoryPath: config.repositoryPath, runtimeDir, processRunner, herdr, maxConcurrency: config.maxConcurrency, runnerOwner: owner, runnerLockHeld: true, isProcessAlive, runTicket: (ticket) => runner.runTicket(ticketContract(config, ticket)) });
  try {
    const recovered = await scheduler.recover({ recoverTicket: async (id) => {
      const retained = readJson(path.join(runtimeDir, id, "state.json"));
      const kind = retained.phase === "worker_waiting" ? "worker" : ["review_waiting", "done"].includes(retained.phase) ? "review" : undefined;
      if (!kind || typeof retained.target !== "string") return { status: "blocked", reason: "exact retained recovery identity is unavailable" };
      return runner.recoverSettledResult(ticketContract(config, config.tickets.find((ticket) => ticket.id === id)), { expectedTarget: retained.target, expectedKind: kind, finalizeDone: true, ...(kind === "review" ? { expectedCandidateHash: retained.candidateHash } : {}) });
    }});
    if (recovered.status === "blocked") return recovered;
    let inboxQueue = Promise.resolve(); const processSerialized = () => { const next = inboxQueue.then(() => scheduler.processInbox({ tickets: config.tickets, validation: config.validation })); inboxQueue = next.then(() => undefined, () => undefined); return next; };
    let batch;
    for (;;) {
      await processSerialized();
      const current = readJson(path.join(runtimeDir, "state.json"));
      if (["done", "stopped", "stop_unconfirmed", "blocked"].includes(current.phase)) break;
      if (current.phase === "ready" && !batch) batch = scheduler.startBatch(config.tickets).finally(() => { batch = undefined; });
      await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 250));
    }
    if (batch) await batch;
    return readJson(path.join(runtimeDir, "state.json"));
  } catch (error) {
    blockRecovery(runtimeDir, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    stopHeartbeat();
    const phase = readJson(path.join(runtimeDir, "state.json")).phase;
    if (["done", "stopped", "stop_unconfirmed", "blocked"].includes(phase)) {
      if (phase !== "blocked") try { fs.unlinkSync(runnerPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
      releaseRunnerLock(lockPath, owner);
    }
  }
}

async function runMain(runtimeDir) { return runDetachedDelivery(runtimeDir); }

if (process.argv[1] === ENTRY) {
  const [mode, target] = process.argv.slice(2);
  const main = mode === "run" ? runMain(target) : mode === "review" ? runStandaloneReview(target) : Promise.reject(new Error("unknown delivery runner mode"));
  main.catch((error) => {
    if (mode === "run" && target && error?.code !== "RUNNER_OWNED") try { const current = readJson(path.join(target, "state.json")); atomicWriteJson(path.join(target, "state.json"), { ...current, phase: "blocked", nextAction: "inspect detached runner failure", reason: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() }); } catch { /* Existing durable state may itself be unreadable. */ }
    if (mode === "review" && target) try { writeReviewBlocked(reviewPaths(target).statusPath, error); } catch { /* Review main already persisted or trusted path was invalid. */ }
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1;
  });
}
