import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { buildChildEnvironment, createHerdrAdapter } from "./lib/herdr.mjs";
import { blockedByIntegration, buildContextPacket, parsePorcelainV1Z, readyTickets, validateRunInput, validateTicketResult } from "./lib/scheduler.mjs";

export const WORKER_MODEL = "9router/cx/gpt-5.6-sol";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RESULT_EXTENSION = path.join(ROOT, "reviewer-result-tool.ts");
const RESULT_TOOL = "delivery_result_write";
const active = new Map();

function result(text, details, isError = false) { return { content: [{ type: "text", text }], details, ...(isError ? { isError: true } : {}) }; }
function safeId(value, label) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new TypeError(`${label} is invalid.`); return value; }
function inside(root, child) { const relative = path.relative(root, child); return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function atomicJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temporary, file); }
function exclusiveJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" }); }
function readJson(file, maximum = 256 * 1024) { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new Error("inspection file is invalid."); return JSON.parse(fs.readFileSync(file, "utf8")); }
function runDir(repositoryPath, runId) { return path.join(repositoryPath, ".scratch", "delivery", safeId(runId, "runId")); }
function git(repositoryPath, args, { env = {}, encoding = "utf8", maxBuffer = 2 * 1024 * 1024 } = {}) { return new Promise((resolve, reject) => execFile("git", args, { cwd: repositoryPath, env: { ...buildChildEnvironment(), ...env }, encoding, maxBuffer, timeout: 30_000, shell: false }, (error, stdout, stderr) => error ? reject(new Error(`git ${args.join(" ")} failed: ${String(stderr).trim()}`)) : resolve(stdout))); }
export function runValidation(spec, worktreePath, timeoutMs) {
  if (!spec || typeof spec.executable !== "string" || !spec.executable || !Array.isArray(spec.args) || spec.args.some((value) => typeof value !== "string")) throw new TypeError("validation executable and args are invalid.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("validation timeout must be a positive safe integer.");
  const cwd = fs.realpathSync(path.resolve(worktreePath, spec.cwd ?? ".")); const root = fs.realpathSync(worktreePath);
  if (cwd !== root && !inside(root, cwd)) throw new Error("validation cwd escapes worktree.");
  if (process.platform === "win32") throw new Error("validation process-tree termination is unsupported on win32.");
  const startedAt = performance.now(); const maximum = 2 * 1024 * 1024; const graceMs = 250;
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let timedOut = false; let outputExceeded = false; let settled = false; let stopping = false; let closed = false; let escalation; let forcedSettlement;
    const child = spawn(spec.executable, spec.args, { cwd, env: buildChildEnvironment(), detached: true, stdio: ["ignore", "pipe", "pipe"], shell: false });
    const append = (current, chunk) => { const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); const room = maximum - current.length; if (value.length > room) { outputExceeded = true; stop(); } return room > 0 ? Buffer.concat([current, value.subarray(0, room)]) : current; };
    const signalGroup = (signal) => { if (!child.pid || closed) return; try { process.kill(-child.pid, signal); } catch (error) { if (error?.code !== "ESRCH") stderr = append(stderr, `${error instanceof Error ? error.message : String(error)}\n`); } };
    const finish = (code, signal) => { if (settled) return; settled = true; clearTimeout(timeout); clearTimeout(escalation); clearTimeout(forcedSettlement); child.stdout?.destroy(); child.stderr?.destroy(); resolve({ passed: code === 0 && !timedOut && !outputExceeded, timedOut, outputExceeded, code: code ?? signal ?? "spawn_error", stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), timeoutMs, elapsedMs: Math.max(0, performance.now() - startedAt) }); };
    const stop = () => { if (stopping || settled) return; stopping = true; signalGroup("SIGTERM"); escalation = setTimeout(() => { signalGroup("SIGKILL"); forcedSettlement = setTimeout(() => finish(null, "termination_deadline"), graceMs); }, graceMs); };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); }); child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const timeout = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    child.once("error", (error) => { stderr = append(stderr, error.message); finish(null, "spawn_error"); });
    child.once("close", (code, signal) => { closed = true; finish(code, signal); });
  });
}
function statePath(directory) { return path.join(directory, "status.json"); }
function save(directory, state) { state.updatedAt = new Date().toISOString(); atomicJson(statePath(directory), state); return state; }
function contextFilesExist(repositoryPath, paths) { for (const item of paths) { const resolved = path.resolve(repositoryPath, item); const stat = fs.lstatSync(resolved); if (!inside(repositoryPath, resolved) || !stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error(`context file is unavailable: ${item}`); } }
function parseAgentState(value) { return value?.agent?.agent_status ?? value?.agent?.status ?? value?.agent?.state ?? value?.event?.agent_status ?? value?.status ?? value?.state ?? "unknown"; }
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function patchPaths(directory, ticketId) { return { patch: path.join(directory, "patches", `${safeId(ticketId, "ticketId")}.patch`), metadata: path.join(directory, "patches", `${ticketId}.json`) }; }
function summary(state) {
  const tickets = Object.values(state.tickets ?? {}); const count = (status) => tickets.filter((ticket) => ticket.status === status).length;
  const counts = { running: count("running"), validated: count("validation_passed"), integrated: count("integrated"), eligible: count("integrated"), cleaned: count("cleaned"), retained: tickets.filter((ticket) => ["blocked", "failed", "stopped"].includes(ticket.status)).length };
  const nextAction = counts.eligible ? `Run delivery_cleanup for ${counts.eligible} integrated ticket${counts.eligible === 1 ? "" : "s"}.` : counts.validated ? "Integrate exact validated patches and call delivery_continue." : counts.running ? "Inspect active Herdr agents." : "Inspect retained evidence and resources.";
  return { counts, nextAction };
}
async function waitForInitialActivity(herdr, target, resultPath, deadlineMs, now = Date.now) {
  const activityDeadline = Math.min(deadlineMs, now() + 10_000);
  while (true) {
    if (fs.existsSync(resultPath)) return "result";
    const remainingMs = Math.min(activityDeadline, deadlineMs) - now();
    if (remainingMs <= 0) return "timeout";
    const status = parseAgentState(await herdr.agentGet(target));
    if (["working", "blocked", "done", "idle"].includes(status) && status !== "idle") return status;
    if (now() >= activityDeadline) throw new Error(`initial ticket prompt produced no working or blocked state; current status ${status}.`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadlineMs - now()))));
  }
}

export function remainingOperationTimeout(deadlineMs, nowMs = Date.now()) { return Math.min(300_000, Math.max(0, deadlineMs - nowMs)); }

export async function waitForAgentDeadline(herdr, target, deadlineMs, now = Date.now) {
  const startedMs = now();
  while (true) {
    const remainingMs = deadlineMs - now();
    if (remainingMs <= 0) return { timedOut: true, deadlineMs, elapsedMs: Math.max(0, now() - startedMs) };
    let waited;
    try { waited = await herdr.agentWait({ target, timeout: Math.min(remainingMs, 300_000) }); }
    catch {}
    const live = await herdr.agentGet(target); const status = parseAgentState(live);
    if (["idle", "done", "blocked"].includes(status)) return { timedOut: false, response: waited ?? live, status, deadlineMs, elapsedMs: Math.max(0, now() - startedMs) };
    if (status !== "working") throw new Error(`agent settled in unknown state ${status}.`);
  }
}

async function verifyRepository(repositoryPath, baseSha, worktreeRoot, herdr) {
  const root = fs.realpathSync(repositoryPath);
  if (!path.isAbsolute(worktreeRoot) || path.normalize(worktreeRoot) !== worktreeRoot) throw new Error("worktreeRoot must be a normalized absolute path to an existing real directory outside the repository.");
  let worktreeReal; let stat; try { worktreeReal = fs.realpathSync(worktreeRoot); stat = fs.lstatSync(worktreeRoot); } catch { throw new Error("worktreeRoot must be a normalized absolute path to an existing real directory outside the repository."); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || worktreeReal === root || worktreeReal.startsWith(`${root}${path.sep}`)) throw new Error("worktreeRoot must be a normalized absolute path to an existing real directory outside the repository.");
  if (process.env.HERDR_ENV !== "1") throw new Error("HERDR_ENV=1 is required.");
  await herdr.status(); const integrations = await herdr.integrationStatus(); if (!integrations.some((entry) => entry.name === "pi" && entry.status.startsWith("current (v"))) throw new Error("Herdr Pi integration is not current.");
  const top = (await git(root, ["rev-parse", "--show-toplevel"])).trim(); if (fs.realpathSync(top) !== root) throw new Error("cwd must be repository root.");
  if ((await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length) throw new Error("parent checkout must be clean.");
  const resolved = (await git(root, ["rev-parse", "--verify", `${baseSha}^{commit}`])).trim(); if (resolved !== baseSha) throw new Error("baseSha must be exact immutable commit.");
  await git(root, ["check-ignore", "-q", ".scratch/"]); return root;
}

function owned(ticket, file) { return ticket.ownedPaths.some((claim) => claim.endsWith("/") ? file.startsWith(claim) : file === claim); }
async function inspectWorkerTree(worktreePath, baseSha, ticket) {
  const head = (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
  const changes = parsePorcelainV1Z(await git(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  return { head, changes, violations: changes.filter((file) => !owned(ticket, file)), valid: head === baseSha && changes.every((file) => owned(ticket, file)) };
}
async function reconcileStartupFailure(herdr, target, created, worktreePath) {
  const evidence = { agent: null, workspace: null, errors: [] };
  try { evidence.agent = await herdr.agentGet(target); } catch (error) { evidence.errors.push(`agentGet: ${error instanceof Error ? error.message : String(error)}`); }
  try {
    const listed = await herdr.workspaceList();
    if (!Array.isArray(listed?.workspaces)) evidence.errors.push("workspaceList: malformed response");
    else evidence.workspace = listed.workspaces.find((workspace) => workspace.workspace_id === created.workspace) ?? null;
  } catch (error) { evidence.errors.push(`workspaceList: ${error instanceof Error ? error.message : String(error)}`); }
  const livePath = evidence.workspace?.worktree?.checkout_path;
  evidence.identityMatches = Boolean(evidence.workspace && path.resolve(livePath ?? "") === path.resolve(worktreePath));
  return evidence;
}
function validationFeedback(validation) { const text = `${validation.stdout}${validation.stderr}`; const maximum = 8192; return text.length <= maximum ? text : `${text.slice(0, maximum)}\n[truncated; full output in immutable log]`; }
function handoff(ticket, runtime, worktreePath, branch, agentResult, validation, changes, patchEvidence) { return { version: 2, ticketId: ticket.id, status: agentResult.status, summary: agentResult.summary, handoff: agentResult.handoff, question: agentResult.question ?? null, branch, workspace: runtime.workspace, pane: runtime.pane, target: runtime.target, worktreePath, changedPaths: changes, validation, patchEvidence, promptPath: runtime.promptPath, resultPath: runtime.resultPath, rounds: runtime.rounds, fixCount: runtime.fixCount, deadlineAt: runtime.deadlineAt, waitElapsedMs: runtime.waitElapsedMs, timing: runtime.timing, createdAt: new Date().toISOString() }; }

async function capturePatch(directory, ticket, worktreePath, baseSha, changedPaths) {
  const files = patchPaths(directory, ticket.id); fs.mkdirSync(path.dirname(files.patch), { recursive: true, mode: 0o700 });
  const index = path.join(os.tmpdir(), `delivery-index-${process.pid}-${randomBytes(8).toString("hex")}`); const env = { GIT_INDEX_FILE: index };
  try {
    await git(worktreePath, ["read-tree", baseSha], { env }); await git(worktreePath, ["add", "-A"], { env });
    const patch = await git(worktreePath, ["diff", "--binary", "--full-index", "--cached", baseSha], { env, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
    fs.writeFileSync(files.patch, patch, { mode: 0o600, flag: "wx" });
    const metadata = { version: 1, ticketId: ticket.id, baseSha, sha256: digest(patch), byteLength: patch.length, changedPaths, capture: "temporary-index-binary-diff", capturedAt: new Date().toISOString() };
    atomicJson(files.metadata, metadata); return { ...metadata, patchPath: files.patch, metadataPath: files.metadata };
  } finally { try { fs.unlinkSync(index); } catch {} try { fs.unlinkSync(`${index}.lock`); } catch {} }
}

async function verifyIntegratedPatch(root, directory, ticketId, ticket) {
  const files = patchPaths(directory, ticketId); const metadata = readJson(files.metadata); const patch = fs.readFileSync(files.patch);
  if (metadata.ticketId !== ticketId || metadata.sha256 !== digest(patch) || metadata.byteLength !== patch.length || metadata.baseSha !== ticket.patchEvidence?.baseSha) throw new Error(`${ticketId} patch evidence is invalid.`);
  if (patch.length) try { await git(root, ["apply", "--check", "--reverse", "--binary", files.patch]); } catch { throw new Error(`${ticketId} exact validated patch is not present at parent HEAD.`); }
  return { patchSha256: metadata.sha256, method: patch.length ? "git-apply-check-reverse" : "empty-patch" };
}

export function createDeliveryWorkflowCore({ herdr = createHerdrAdapter({ env: buildChildEnvironment() }), nonce = () => randomBytes(24).toString("hex") } = {}) {
  async function executeTicket(repositoryPath, directory, run, ticket, state, worktreeRoot) {
    const executionStarted = performance.now(); const deadlineMs = Date.now() + ticket.timeoutSeconds * 1000;
    const evidence = { contextBytes: 0, startupElapsedMs: 0, workerElapsedMs: 0, validationElapsedMs: 0, fixCount: 0, rounds: [], deadlineAt: new Date(deadlineMs).toISOString() };
    let created; let target = ticket.worker.name; let worktreePath; let branch; let currentPromptPath; let currentResultPath;
    const terminal = (outcome) => ({ ...outcome, ...(target ? { target } : {}), ...(created ? { pane: created.pane, workspace: created.workspace } : {}), ...(worktreePath ? { worktreePath, branch } : {}), ...(currentPromptPath ? { promptPath: currentPromptPath, resultPath: currentResultPath } : {}), rounds: evidence.rounds, fixCount: evidence.fixCount, deadlineAt: evidence.deadlineAt, timing: { contextBytes: evidence.contextBytes, startupElapsedMs: evidence.startupElapsedMs, workerElapsedMs: evidence.workerElapsedMs, validationElapsedMs: evidence.validationElapsedMs, totalElapsedMs: Math.max(0, performance.now() - executionStarted), fixCount: evidence.fixCount } });
    state.tickets[ticket.id] = { ...state.tickets[ticket.id], status: "running", launchStartedAt: new Date().toISOString(), deadlineAt: evidence.deadlineAt, timing: { contextBytes: 0, startupElapsedMs: 0, workerElapsedMs: 0, validationElapsedMs: 0, totalElapsedMs: 0, fixCount: 0 } }; save(directory, state);
    contextFilesExist(repositoryPath, ticket.specPaths);
    const ticketDir = path.join(directory, "tickets", ticket.id); fs.mkdirSync(ticketDir, { recursive: true, mode: 0o700 });
    worktreePath = path.join(worktreeRoot, `${run.runId}-${ticket.id}`); branch = `delivery/${run.runId}-${ticket.id}`;
    created = await herdr.worktreeCreate({ cwd: repositoryPath, branch, base: run.baseSha, path: worktreePath, label: `${run.runId} ${ticket.id}`, focus: false });
    if (path.resolve(created.path) !== path.resolve(worktreePath) || typeof created.pane !== "string" || typeof created.workspace !== "string") throw new Error("Herdr returned unexpected worktree, pane, or workspace.");
    currentPromptPath = path.join(directory, "prompts", `${ticket.id}.md`); currentResultPath = path.join(directory, "results", `${ticket.id}.json`); const bindingDir = path.join(ticketDir, "result-bindings"); const ticketNonce = nonce();
    const dependencyHandoffs = ticket.dependencies.map((dependency) => ({ ticketId: dependency, handoff: state.tickets[dependency].handoff }));
    const packet = buildContextPacket({ run, ticket, repositoryPath, worktreePath, promptPath: currentPromptPath, resultPath: currentResultPath, nonce: ticketNonce, dependencyHandoffs, guidance: state.guidance?.[ticket.id] ?? "" }); evidence.contextBytes = Buffer.byteLength(packet);
    fs.mkdirSync(path.dirname(currentPromptPath), { recursive: true, mode: 0o700 }); fs.mkdirSync(path.dirname(currentResultPath), { recursive: true, mode: 0o700 }); fs.writeFileSync(currentPromptPath, packet, { mode: 0o600, flag: "wx" });
    exclusiveJson(path.join(bindingDir, "round-0.json"), { version: 1, round: 0, ticketId: ticket.id, nonce: ticketNonce, resultPath: currentResultPath });
    const tools = [...new Set([...ticket.worker.tools, RESULT_TOOL])];
    state.tickets[ticket.id] = { ...state.tickets[ticket.id], status: "running", target, pane: created.pane, workspace: created.workspace, worktreePath, branch, promptPath: currentPromptPath, resultPath: currentResultPath, startedAt: new Date().toISOString(), contextBytes: evidence.contextBytes, timing: { contextBytes: evidence.contextBytes, startupElapsedMs: 0, workerElapsedMs: 0, validationElapsedMs: 0, totalElapsedMs: 0, fixCount: 0 } }; save(directory, state);
    const initialPrompt = `Read and follow the complete ticket context at ${currentPromptPath}. Call ${RESULT_TOOL} exactly once when settled.`;
    const startupStarted = performance.now(); const startupRemaining = remainingOperationTimeout(deadlineMs);
    if (startupRemaining <= 0) return terminal({ status: "blocked", reason: "ticket deadline expired before agent startup; workspace retained" });
    try { await herdr.agentStart({ name: target, kind: ticket.worker.kind, pane: created.pane, timeout: startupRemaining, agentArgs: ["--model", ticket.worker.model, "--thinking", ticket.worker.thinking, "--extension", RESULT_EXTENSION, "--delivery-result-path", currentResultPath, "--delivery-result-nonce", ticketNonce, "--delivery-result-binding-dir", bindingDir, "--tools", tools.join(","), "--", initialPrompt] }); }
    catch (error) {
      evidence.startupElapsedMs = Math.max(0, performance.now() - startupStarted);
      const message = error instanceof Error ? error.message : String(error); const reconciliation = await reconcileStartupFailure(herdr, target, created, worktreePath);
      return terminal({ status: "blocked", reason: `${message}; agent startup outcome uncertain, workspace retained`, startupReconciliation: reconciliation });
    }
    let activity;
    try { activity = await waitForInitialActivity(herdr, target, currentResultPath, deadlineMs); }
    catch (error) { evidence.startupElapsedMs = Math.max(0, performance.now() - startupStarted); return terminal({ status: "blocked", reason: `${error instanceof Error ? error.message : String(error)}; startup state unknown, workspace retained` }); }
    evidence.startupElapsedMs = Math.max(0, performance.now() - startupStarted); state.tickets[ticket.id].timing.startupElapsedMs = evidence.startupElapsedMs; save(directory, state);
    let roundStarted = performance.now();
    let wait = activity === "timeout" ? { timedOut: true, deadlineMs, elapsedMs: 0 } : await waitForAgentDeadline(herdr, target, deadlineMs);
    let agentResult; let validation; let changes;
    while (true) {
      if (wait.timedOut) { evidence.workerElapsedMs += Math.max(0, performance.now() - roundStarted); return terminal({ status: "blocked", reason: "ticket deadline expired; agent and workspace retained", waitElapsedMs: wait.elapsedMs }); }
      let status = wait.status ?? parseAgentState(wait.response);
      if (!["idle", "done", "blocked", "working"].includes(status)) { const live = await herdr.agentGet(target); status = parseAgentState(live); }
      if (status === "working") { wait = await waitForAgentDeadline(herdr, target, deadlineMs); continue; }
      if (!["idle", "done", "blocked"].includes(status)) return terminal({ status: "blocked", reason: `agent settled in unknown state ${status}.` });
      const executionElapsedMs = Math.max(0, performance.now() - roundStarted); evidence.workerElapsedMs += executionElapsedMs;
      const round = { round: evidence.fixCount, promptPath: currentPromptPath, resultPath: currentResultPath, executionElapsedMs, waitElapsedMs: wait.elapsedMs ?? 0 }; evidence.rounds.push(round);
      if (!fs.existsSync(currentResultPath)) return terminal({ status: "blocked", reason: status === "blocked" ? "agent blocked without result file." : "agent settled without result file." });
      agentResult = validateTicketResult(readJson(currentResultPath, 64 * 1024), ticket.id);
      if (agentResult.status !== "done") return terminal({ status: agentResult.status, reason: agentResult.summary, question: agentResult.question ?? null, handoff: agentResult.handoff ?? "" });
      if (agentResult.validation === "failed") return terminal({ status: "failed", reason: "agent reported failed validation" });
      const beforeValidation = await inspectWorkerTree(worktreePath, run.baseSha, ticket);
      if (beforeValidation.head !== run.baseSha) return terminal({ status: "blocked", reason: "worker committed or moved HEAD before validation; validation not executed" });
      if (beforeValidation.violations.length) return terminal({ status: "blocked", reason: `ownership violation before validation; validation not executed: ${beforeValidation.violations.join(", ")}` });
      validation = await runValidation(ticket.validation, worktreePath, ticket.validationTimeoutSeconds * 1000); evidence.validationElapsedMs += validation.elapsedMs;
      const logPath = path.join(directory, "logs", `${ticket.id}.round-${evidence.fixCount}.log`); fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 }); fs.writeFileSync(logPath, `${validation.stdout}${validation.stderr}`, { mode: 0o600, flag: "wx" });
      const afterValidation = await inspectWorkerTree(worktreePath, run.baseSha, ticket); changes = afterValidation.changes;
      Object.assign(round, { logPath, validation: { passed: validation.passed, timedOut: validation.timedOut, outputExceeded: validation.outputExceeded, timeoutMs: validation.timeoutMs, elapsedMs: validation.elapsedMs }, changedPaths: changes });
      if (afterValidation.head !== run.baseSha) return terminal({ status: "blocked", reason: "validation moved HEAD; result rejected" });
      if (afterValidation.violations.length) return terminal({ status: "blocked", reason: `ownership violation after validation; result rejected: ${afterValidation.violations.join(", ")}` });
      if (validation.passed) break;
      if (evidence.fixCount >= ticket.maxFixRounds) return terminal({ status: "failed", reason: validation.timedOut ? "validation deadline expired; fix rounds exhausted" : "validation failed; fix rounds exhausted", validation });
      evidence.fixCount += 1; const fixNonce = nonce(); currentPromptPath = path.join(directory, "prompts", `${ticket.id}.fix-${evidence.fixCount}.md`); currentResultPath = path.join(directory, "results", `${ticket.id}.fix-${evidence.fixCount}.json`);
      const feedback = validationFeedback(validation); const fixPrompt = `# Delivery repair round ${evidence.fixCount}\n\nRuntime validation ${validation.timedOut ? "timed out" : "failed"}. Repair only ticket ${ticket.id} in same worktree and ownership. Do not commit or widen scope.\n\nValidation: \`${ticket.validation.executable} ${ticket.validation.args.join(" ")}\`\nFull log: \`${logPath}\`\n\nBounded output:\n\`\`\`text\n${feedback}\n\`\`\`\n\nCall \`${RESULT_TOOL}\` exactly once with nonce \`${fixNonce}\`, ticketId \`${ticket.id}\`, and normal version 1 result fields.\n`;
      fs.writeFileSync(currentPromptPath, fixPrompt, { mode: 0o600, flag: "wx" }); exclusiveJson(path.join(bindingDir, `round-${evidence.fixCount}.json`), { version: 1, round: evidence.fixCount, ticketId: ticket.id, nonce: fixNonce, resultPath: currentResultPath });
      const remainingMs = deadlineMs - Date.now(); if (remainingMs <= 0) return terminal({ status: "blocked", reason: "ticket deadline expired before repair prompt; agent and workspace retained" });
      roundStarted = performance.now();
      try {
        const response = await herdr.agentPrompt({ target, prompt: `Read and follow repair context at ${currentPromptPath}. Call ${RESULT_TOOL} exactly once when settled.`, wait: true, timeout: Math.min(remainingMs, 300_000) });
        const promptStatus = parseAgentState(response); wait = promptStatus === "working" ? await waitForAgentDeadline(herdr, target, deadlineMs) : { timedOut: false, response, status: promptStatus, deadlineMs, elapsedMs: Math.max(0, performance.now() - roundStarted) };
      } catch {
        const live = await herdr.agentGet(target); const liveStatus = parseAgentState(live); wait = liveStatus === "working" ? await waitForAgentDeadline(herdr, target, deadlineMs) : { timedOut: false, response: live, status: liveStatus, deadlineMs, elapsedMs: Math.max(0, performance.now() - roundStarted) };
      }
    }
    const patchEvidence = await capturePatch(directory, ticket, worktreePath, run.baseSha, changes); const runtime = { promptPath: currentPromptPath, resultPath: currentResultPath, rounds: evidence.rounds, fixCount: evidence.fixCount, workspace: created.workspace, pane: created.pane, target, deadlineAt: evidence.deadlineAt, waitElapsedMs: evidence.rounds.reduce((sum, round) => sum + round.waitElapsedMs, 0), timing: terminal({}).timing };
    const value = handoff(ticket, runtime, worktreePath, branch, agentResult, { passed: true, executable: ticket.validation.executable, args: ticket.validation.args, timeoutMs: validation.timeoutMs, elapsedMs: validation.elapsedMs }, changes, patchEvidence); atomicJson(path.join(directory, "handoffs", `${ticket.id}.json`), value); return { ...value, timing: runtime.timing, status: "validation_passed" };
  }

  async function run(repositoryPath, input, existing = false) {
    const run = validateRunInput(input); const root = await verifyRepository(repositoryPath, run.baseSha, input.worktreeRoot, herdr); contextFilesExist(root, run.contextPaths);
    const directory = runDir(root, run.runId); if (!existing) { fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 }); fs.mkdirSync(directory, { recursive: false, mode: 0o700 }); atomicJson(path.join(directory, "run.json"), { ...run, version: 2, worktreeRoot: input.worktreeRoot, createdAt: new Date().toISOString() }); }
    const queuedAt = new Date().toISOString();
    const state = existing ? readJson(statePath(directory)) : { version: 2, runId: run.runId, baseSha: run.baseSha, phase: "running", tickets: Object.fromEntries(run.tickets.map((ticket) => [ticket.id, { status: "pending", queuedAt }])), guidance: {}, updatedAt: queuedAt };
    active.set(directory, { state, run });
    const running = new Map(); let launchBlocked = false;
    const launch = (ticketId) => {
      const ticket = run.tickets.find((item) => item.id === ticketId);
      const promise = (async () => {
        let outcome; try { outcome = await executeTicket(root, directory, run, ticket, state, input.worktreeRoot); } catch (error) { outcome = { status: "blocked", reason: error instanceof Error ? error.message : String(error), ...(state.tickets[ticketId]?.timing ? { timing: state.tickets[ticketId].timing } : {}) }; }
        state.tickets[ticketId] = { ...state.tickets[ticketId], ...outcome, settledAt: new Date().toISOString() }; save(directory, state); return [ticketId, outcome];
      })();
      running.set(ticketId, promise); promise.finally(() => running.delete(ticketId));
    };
    try {
      while (true) {
        if (state.stopRequested || Object.values(state.tickets).some((ticket) => ["blocked", "failed", "stopped"].includes(ticket.status))) launchBlocked = true;
        if (!launchBlocked) {
          const slots = run.maxConcurrency - running.size;
          for (const ticketId of readyTickets(run.tickets, state.tickets).slice(0, slots)) launch(ticketId);
        }
        if (!running.size) break;
        const [, outcome] = await Promise.race(running.values());
        if (outcome.status !== "validation_passed") launchBlocked = true;
      }
      if (state.stopRequested) { state.phase = "stopped"; state.nextAction = "Inspect retained Herdr panes/worktrees."; save(directory, state); }
      else if (launchBlocked) { state.phase = "blocked"; state.nextAction = "Inspect retained Herdr pane/worktree and resolve blocker."; save(directory, state); }
      else { const pending = Object.values(state.tickets).some((ticket) => ticket.status === "pending"); const awaiting = pending && blockedByIntegration(run.tickets, state.tickets); const unintegrated = Object.values(state.tickets).some((ticket) => ticket.status === "validation_passed"); const integrated = Object.values(state.tickets).some((ticket) => ticket.status === "integrated"); state.phase = awaiting || unintegrated ? "awaiting_integration" : pending ? "blocked" : integrated ? "awaiting_cleanup" : "done"; Object.assign(state, summary(state)); save(directory, state); }
      return state;
    } finally { active.delete(directory); }
  }

  return Object.freeze({
    async start(repositoryPath, input) { const state = await run(repositoryPath, input, false); return result(`Delivery ${input.runId}: ${state.phase}. ${state.nextAction}`, state, state.phase === "blocked"); },
    async status(repositoryPath, input) { const directory = runDir(repositoryPath, input.runId); if (!fs.existsSync(statePath(directory))) return result(`Run ${input.runId} not found.`, { status: "not_found" }, true); const state = readJson(statePath(directory)); const view = summary(state); const reasons = Object.entries(state.tickets ?? {}).filter(([, ticket]) => ticket.reason).map(([ticketId, ticket]) => `${ticketId}: ${ticket.reason}`); return result(`Delivery ${input.runId}: ${state.phase}. ${view.counts.running} running; ${view.counts.validated} validated; ${view.counts.integrated} integrated; ${view.counts.eligible} eligible; ${view.counts.cleaned} cleaned; ${view.counts.retained} retained.${reasons.length ? ` ${reasons.join("; ")}.` : ""} Next: ${view.nextAction}`, { ...state, ...view }); },
    async steer(repositoryPath, input) { const directory = runDir(repositoryPath, input.runId); const running = active.get(directory); if (!running) return result("Run is not active in this Pi process; inspect Herdr and start a new supervised run if needed.", { status: "not_active" }, true); const ticket = running.state.tickets[safeId(input.ticketId, "ticketId")]; if (ticket?.status !== "running" || !ticket.target) return result("Ticket has no active target.", { status: "not_active" }, true); const liveState = parseAgentState(await herdr.agentGet(ticket.target)); if (liveState !== "working") return result(`Ticket agent is ${liveState}; guidance not sent.`, { status: "not_active", agentState: liveState }, true); await herdr.agentPrompt({ target: ticket.target, prompt: input.message, wait: false, timeout: 30_000 }); return result("Guidance sent; delivery is not proof of compliance.", { status: "sent", target: ticket.target }); },
    async stop(repositoryPath, input) { const directory = runDir(repositoryPath, input.runId); const running = active.get(directory); const state = fs.existsSync(statePath(directory)) ? readJson(statePath(directory)) : null; const targets = input.ticketId ? [state?.tickets?.[input.ticketId]].filter((ticket) => ticket?.status === "running") : Object.values(state?.tickets ?? {}).filter((ticket) => ticket.status === "running"); if (!targets.length) return result("No active recorded ticket target.", { status: "not_active" }, true); for (const ticket of targets) if (ticket.target) await herdr.agentSendKeys({ target: ticket.target, keys: ["ctrl+c"] }); if (running) { running.state.stopRequested = true; running.state.nextAction = "Wait for active tickets to settle; no new tickets will launch."; save(directory, running.state); } return result("Stop requested. No new ticket will launch; pane/worktree retained.", { status: "stop_requested", targets: targets.map((ticket) => ticket.target) }); },
    async continue(repositoryPath, input) { const directory = runDir(repositoryPath, input.runId); if (active.has(directory)) return result("Run is already active.", { status: "active" }, true); const savedRun = readJson(path.join(directory, "run.json")); const state = readJson(statePath(directory)); if (savedRun.version !== 2 || state.version !== 2) return result("Legacy run lacks immutable patch evidence and cannot continue.", { status: "blocked" }, true); if (state.phase !== "awaiting_integration") return result("Run is not awaiting integration.", { status: state.phase }, true); const root = fs.realpathSync(repositoryPath); if (input.integratedSha === state.baseSha || (await git(root, ["rev-parse", "HEAD"])).trim() !== input.integratedSha || (await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length) return result("Integrated SHA must be a new clean current parent HEAD.", { status: "blocked" }, true); try { await git(root, ["merge-base", "--is-ancestor", state.baseSha, input.integratedSha]); } catch { return result("Integrated SHA must descend from prior base SHA.", { status: "blocked" }, true); }
      const candidates = Object.entries(state.tickets).filter(([, ticket]) => ticket.status === "validation_passed"); const verified = [];
      try { for (const [ticketId, ticket] of candidates) verified.push([ticketId, await verifyIntegratedPatch(root, directory, ticketId, ticket)]); } catch (error) { return result(error instanceof Error ? error.message : String(error), { status: "blocked" }, true); }
      for (const [ticketId, evidence] of verified) state.tickets[ticketId] = { ...state.tickets[ticketId], status: "integrated", integrationEvidence: { ...evidence, integratedSha: input.integratedSha, verifiedAt: new Date().toISOString() } };
      savedRun.baseSha = input.integratedSha; state.baseSha = input.integratedSha; state.phase = "running"; save(directory, state); atomicJson(path.join(directory, "run.json"), savedRun); const next = await run(root, savedRun, true); return result(`Delivery ${input.runId}: ${next.phase}. ${next.nextAction}`, next, next.phase === "blocked"); },
    async cleanup(repositoryPath, input) { const directory = runDir(repositoryPath, input.runId); if (active.has(directory)) return result("Run is active; cleanup refused.", { status: "blocked", cleaned: [], alreadyCleaned: [], retained: [{ ticketId: "*", reason: "run active" }] }, true); const state = readJson(statePath(directory)); if (state.version !== 2) return result("Legacy run lacks immutable patch evidence; cleanup refused.", { status: "blocked", cleaned: [], alreadyCleaned: [], retained: [{ ticketId: "*", reason: "legacy evidence" }] }, true); const root = fs.realpathSync(repositoryPath); if ((await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length) return result("Parent checkout must be clean; cleanup refused.", { status: "blocked", cleaned: [], alreadyCleaned: [], retained: [{ ticketId: "*", reason: "dirty parent" }] }, true); await herdr.status(); const live = await herdr.workspaceList(); if (!Array.isArray(live.workspaces)) return result("Herdr workspace state is malformed; cleanup refused.", { status: "blocked", cleaned: [], alreadyCleaned: [], retained: [{ ticketId: "*", reason: "unknown Herdr state" }] }, true); const byId = new Map(live.workspaces.map((workspace) => [workspace.workspace_id, workspace])); const cleaned = []; const alreadyCleaned = []; const retained = [];
      for (const [ticketId, ticket] of Object.entries(state.tickets).sort(([a], [b]) => a.localeCompare(b))) {
        if (ticket.status === "cleaned") { alreadyCleaned.push(ticketId); continue; }
        if (ticket.status !== "integrated") { retained.push({ ticketId, reason: `status ${ticket.status}` }); continue; }
        try {
          const head = (await git(root, ["rev-parse", "HEAD"])).trim(); await git(root, ["merge-base", "--is-ancestor", ticket.integrationEvidence.integratedSha, head]); await verifyIntegratedPatch(root, directory, ticketId, ticket);
          const workspace = byId.get(ticket.workspace); const livePath = workspace?.worktree?.checkout_path; if (!workspace || path.resolve(livePath ?? "") !== path.resolve(ticket.worktreePath) || !["idle", "done"].includes(workspace.agent_status)) throw new Error(!workspace ? "workspace missing or unknown" : `workspace identity or agent state ${workspace.agent_status ?? "unknown"} is unsafe`);
          const removal = await herdr.worktreeRemove({ workspace: ticket.workspace, force: true }); state.tickets[ticketId] = { ...ticket, status: "cleaned", cleanupEvidence: { workspace: ticket.workspace, worktreePath: ticket.worktreePath, patchSha256: ticket.patchEvidence.sha256, cleanedAt: new Date().toISOString(), resultType: removal?.type ?? "worktree_removed" } }; save(directory, state); cleaned.push(ticketId);
        } catch (error) { const reason = error instanceof Error ? error.message : String(error); retained.push({ ticketId, reason }); state.tickets[ticketId] = { ...ticket, cleanupFailure: { reason, attemptedAt: new Date().toISOString() } }; save(directory, state); }
      }
      state.phase = Object.values(state.tickets).every((ticket) => ticket.status === "cleaned") ? "cleaned" : state.phase; Object.assign(state, summary(state)); save(directory, state); const isError = retained.some(({ ticketId }) => state.tickets[ticketId]?.status === "integrated"); return result(`Delivery ${input.runId}: ${cleaned.length} cleaned; ${alreadyCleaned.length} already cleaned; ${retained.length} retained.`, { status: isError ? "partial" : "ok", cleaned, alreadyCleaned, retained, ...summary(state) }, isError); },
  });
}
