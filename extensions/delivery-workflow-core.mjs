import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createDeliveryRunner, createProcessRunner, REVIEW_TOOLS, validateTicketRunContract } from "./delivery-runner.mjs";
import { createHerdrAdapter } from "./lib/herdr.mjs";
import { createScheduler, validateTicketGraph } from "./lib/scheduler.mjs";
import { validateCommandSpec } from "./lib/contracts.mjs";
import { atomicWriteJson, readJson } from "./lib/state.mjs";

export const REVIEWER_MODEL = "9router/cc/claude-opus-5-5";
export const WORKER_MODEL = "9router/cx/gpt-5.6-sol";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = fileURLToPath(import.meta.url);
const MAX_FILE_BYTES = 128 * 1024;
const LEGACY_PATHS = [".scratch/pi-subagents", ".pi/subagents"];
const queues = new Map();
const REVIEW_RESULT_TOOL = "delivery_result_write";
const REVIEW_EXTENSION = path.join(ROOT, "reviewer-result-tool.ts");

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

export function createDeliveryWorkflowCore({ spawnProcess = spawn, now = () => new Date(), random = () => Math.random().toString(16).slice(2), processInbox } = {}) {
  const launch = (args, repositoryPath) => {
    const child = spawnProcess(process.execPath, [ENTRY, ...args], { cwd: repositoryPath, env: { ...process.env, DELIVERY_WORKFLOW_PACKAGE_ROOT: ROOT }, detached: true, shell: false, stdio: "ignore" });
    child.unref();
    return child.pid;
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
      const requestPath = path.join(dir, `review-${random()}.json`); atomicWriteJson(requestPath, request); const pid = launch(["review", requestPath], repositoryPath);
      return result(`Fresh ${input.kind} review launched for ${runId}.`, { status: "launched", runId, pid, requestPath, model: REVIEWER_MODEL, tools: REVIEW_TOOLS });
    },
    async start(repositoryPath, input) {
      const runId = safeId(input.runId, "runId"); const dir = runtimePath(repositoryPath, runId);
      const tickets = JSON.parse(input.tickets);
      const graph = validateTicketGraph(tickets); const validation = validateCommandSpec(input.validation);
      for (const ticket of graph) validateTicketRunContract(ticketContract({ runId, repositoryPath, baseSha: input.baseSha, validation }, ticket));
      const config = { version: 1, runId, repositoryPath, baseSha: input.baseSha, tickets: graph, validation, ...(input.maxConcurrency === undefined ? {} : { maxConcurrency: input.maxConcurrency }) };
      fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
      try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code === "EEXIST") return result(`Run ${runId} already exists.`, { status: "exists", runId }, true); throw error; }
      atomicWriteJson(path.join(dir, "config.json"), config);
      atomicWriteJson(path.join(dir, "state.json"), { version: 1, runId, baseSha: input.baseSha, phase: "ready", tickets: Object.fromEntries(config.tickets.map((ticket) => [ticket.id, { status: "ready", attempt: 0 }])), completedSteps: [], nextAction: "start dependency-ready batch", updatedAt: now().toISOString() });
      const pid = launch(["run", dir], repositoryPath);
      return result(`Delivery run ${runId} launched.`, { status: "launched", runId, pid, runtimeDir: dir });
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
  return { ...contract, version: 1, runId: config.runId, ticketId: id, planApproved: true, repositoryPath: config.repositoryPath, baseSha: config.baseSha, ownedPaths: contract.ownedPaths ?? ownedFiles, validation: contract.validation ?? config.validation, worker: { ...contract.worker, model: WORKER_MODEL }, reviewer: { ...contract.reviewer, model: REVIEWER_MODEL } };
}
async function runMain(runtimeDir) {
  const config = readJson(path.join(runtimeDir, "config.json")); const processRunner = createProcessRunner(); const herdr = createHerdrAdapter({ cwd: config.repositoryPath }); const runner = createDeliveryRunner({ herdr, processRunner });
  const scheduler = createScheduler({ repositoryPath: config.repositoryPath, runtimeDir, processRunner, herdr, maxConcurrency: config.maxConcurrency, runTicket: (ticket) => runner.runTicket(ticketContract(config, ticket)) });
  let inboxQueue = Promise.resolve(); const processSerialized = () => { const next = inboxQueue.then(() => scheduler.processInbox({ tickets: config.tickets, validation: config.validation })); inboxQueue = next.then(() => undefined, () => undefined); return next; };
  let batch;
  for (;;) {
    await processSerialized();
    const current = readJson(path.join(runtimeDir, "state.json"));
    if (["done", "stopped", "stop_unconfirmed"].includes(current.phase)) break;
    if (current.phase === "ready" && !batch) batch = scheduler.startBatch(config.tickets).finally(() => { batch = undefined; });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (batch) await batch;
}

if (process.argv[1] === ENTRY) {
  const [mode, target] = process.argv.slice(2);
  const main = mode === "run" ? runMain(target) : mode === "review" ? runStandaloneReview(target) : Promise.reject(new Error("unknown delivery runner mode"));
  main.catch((error) => {
    if (mode === "run" && target) try { const current = readJson(path.join(target, "state.json")); atomicWriteJson(path.join(target, "state.json"), { ...current, phase: "blocked", nextAction: "inspect detached runner failure", reason: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() }); } catch { /* Existing durable state may itself be unreadable. */ }
    if (mode === "review" && target) try { writeReviewBlocked(reviewPaths(target).statusPath, error); } catch { /* Review main already persisted or trusted path was invalid. */ }
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1;
  });
}
