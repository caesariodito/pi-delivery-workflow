import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
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
function readJson(file, maximum = 256 * 1024) { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new Error("inspection file is invalid."); return JSON.parse(fs.readFileSync(file, "utf8")); }
function runDir(repositoryPath, runId) { return path.join(repositoryPath, ".scratch", "delivery", safeId(runId, "runId")); }
function git(repositoryPath, args, { env = {}, encoding = "utf8", maxBuffer = 2 * 1024 * 1024 } = {}) { return new Promise((resolve, reject) => execFile("git", args, { cwd: repositoryPath, env: { ...buildChildEnvironment(), ...env }, encoding, maxBuffer, timeout: 30_000, shell: false }, (error, stdout, stderr) => error ? reject(new Error(`git ${args.join(" ")} failed: ${String(stderr).trim()}`)) : resolve(stdout))); }
function command(spec, worktreePath) { const cwd = fs.realpathSync(path.resolve(worktreePath, spec.cwd ?? ".")); const root = fs.realpathSync(worktreePath); if (cwd !== root && !inside(root, cwd)) throw new Error("validation cwd escapes worktree."); return new Promise((resolve) => execFile(spec.executable, spec.args, { cwd, env: buildChildEnvironment(), encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 300_000, shell: false }, (error, stdout, stderr) => resolve({ passed: !error, code: error?.code ?? 0, stdout, stderr }))); }
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
async function waitForInitialActivity(herdr, target, resultPath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (fs.existsSync(resultPath)) return "result";
    const status = parseAgentState(await herdr.agentGet(target));
    if (["working", "blocked"].includes(status)) return status;
    if (Date.now() >= deadline) throw new Error(`initial ticket prompt produced no working or blocked state; current status ${status}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
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
function handoff(ticket, runtime, worktreePath, branch, agentResult, validation, changes, patchEvidence) { return { version: 2, ticketId: ticket.id, status: agentResult.status, summary: agentResult.summary, handoff: agentResult.handoff, question: agentResult.question ?? null, branch, workspace: runtime.workspace, pane: runtime.pane, target: runtime.target, worktreePath, changedPaths: changes, validation, patchEvidence, promptPath: runtime.promptPath, resultPath: runtime.resultPath, createdAt: new Date().toISOString() }; }

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
    state.tickets[ticket.id] = { ...state.tickets[ticket.id], status: "running", launchStartedAt: new Date().toISOString() }; save(directory, state);
    contextFilesExist(repositoryPath, ticket.specPaths);
    const ticketDir = path.join(directory, "tickets", ticket.id); fs.mkdirSync(ticketDir, { recursive: true, mode: 0o700 });
    const worktreePath = path.join(worktreeRoot, `${run.runId}-${ticket.id}`); const branch = `delivery/${run.runId}-${ticket.id}`;
    const created = await herdr.worktreeCreate({ cwd: repositoryPath, branch, base: run.baseSha, path: worktreePath, label: `${run.runId} ${ticket.id}`, focus: false });
    if (path.resolve(created.path) !== path.resolve(worktreePath) || typeof created.pane !== "string" || typeof created.workspace !== "string") throw new Error("Herdr returned unexpected worktree, pane, or workspace.");
    const promptPath = path.join(directory, "prompts", `${ticket.id}.md`); const resultPath = path.join(directory, "results", `${ticket.id}.json`); const ticketNonce = nonce();
    const dependencyHandoffs = ticket.dependencies.map((dependency) => ({ ticketId: dependency, handoff: state.tickets[dependency].handoff }));
    const packet = buildContextPacket({ run, ticket, repositoryPath, worktreePath, promptPath, resultPath, nonce: ticketNonce, dependencyHandoffs, guidance: state.guidance?.[ticket.id] ?? "" });
    fs.mkdirSync(path.dirname(promptPath), { recursive: true, mode: 0o700 }); fs.mkdirSync(path.dirname(resultPath), { recursive: true, mode: 0o700 }); fs.writeFileSync(promptPath, packet, { mode: 0o600, flag: "wx" });
    const target = ticket.worker.name; const tools = [...new Set([...ticket.worker.tools, RESULT_TOOL])];
    state.tickets[ticket.id] = { ...state.tickets[ticket.id], status: "running", target, pane: created.pane, workspace: created.workspace, worktreePath, branch, promptPath, resultPath, startedAt: new Date().toISOString() }; save(directory, state);
    const initialPrompt = `Read and follow the complete ticket context at ${promptPath}. Call ${RESULT_TOOL} exactly once when settled.`;
    try { await herdr.agentStart({ name: target, kind: ticket.worker.kind, pane: created.pane, timeout: 300_000, agentArgs: ["--model", ticket.worker.model, "--thinking", ticket.worker.thinking, "--extension", RESULT_EXTENSION, "--delivery-result-path", resultPath, "--delivery-result-nonce", ticketNonce, "--tools", tools.join(","), "--", initialPrompt] }); }
    catch (error) { try { await herdr.worktreeRemove({ workspace: created.workspace }); } catch (cleanupError) { throw new Error(`${error instanceof Error ? error.message : String(error)}; pre-agent cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`); } throw new Error(`${error instanceof Error ? error.message : String(error)}; newly created worktree/workspace removed before approval-bound work began`); }
    const initial = await waitForInitialActivity(herdr, target, resultPath); const promptResult = initial === "result" ? await herdr.agentGet(target) : await herdr.agentWait({ target, timeout: 300_000 });
    let status = parseAgentState(promptResult); if (status === "unknown" || !fs.existsSync(resultPath)) { const live = await herdr.agentGet(target); status = parseAgentState(live); }
    if (!["idle", "done", "blocked"].includes(status)) throw new Error(`agent settled in unknown state ${status}.`); if (!fs.existsSync(resultPath)) throw new Error(status === "blocked" ? "agent blocked without result file." : "agent settled without result file.");
    const agentResult = validateTicketResult(readJson(resultPath, 64 * 1024), ticket.id);
    if (agentResult.status !== "done") return { status: agentResult.status, reason: agentResult.summary, question: agentResult.question ?? null, handoff: agentResult.handoff ?? "", target, pane: created.pane, workspace: created.workspace, worktreePath, branch, promptPath, resultPath };
    if (agentResult.validation === "failed") return { status: "failed", reason: "agent reported failed validation", target, pane: created.pane, workspace: created.workspace, worktreePath, branch, promptPath, resultPath };
    const validation = await command(ticket.validation, worktreePath); fs.mkdirSync(path.join(directory, "logs"), { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(directory, "logs", `${ticket.id}.log`), `${validation.stdout}${validation.stderr}`, { mode: 0o600 });
    const head = (await git(worktreePath, ["rev-parse", "HEAD"])).trim(); if (head !== run.baseSha) return { status: "blocked", reason: "worker committed or moved HEAD; only working-tree changes are accepted", target, pane: created.pane, workspace: created.workspace, worktreePath, branch, promptPath, resultPath };
    const changes = parsePorcelainV1Z(await git(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])); const violations = changes.filter((file) => !owned(ticket, file));
    if (violations.length) return { status: "blocked", reason: `ownership violation: ${violations.join(", ")}`, target, pane: created.pane, workspace: created.workspace, worktreePath, branch, promptPath, resultPath };
    if (!validation.passed) return { status: "failed", reason: "validation failed", target, pane: created.pane, workspace: created.workspace, worktreePath, branch, promptPath, resultPath, validation };
    const patchEvidence = await capturePatch(directory, ticket, worktreePath, run.baseSha, changes); const runtime = { promptPath, resultPath, workspace: created.workspace, pane: created.pane, target };
    const value = handoff(ticket, runtime, worktreePath, branch, agentResult, { passed: true, executable: ticket.validation.executable, args: ticket.validation.args }, changes, patchEvidence); atomicJson(path.join(directory, "handoffs", `${ticket.id}.json`), value); return { ...value, status: "validation_passed" };
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
        let outcome; try { outcome = await executeTicket(root, directory, run, ticket, state, input.worktreeRoot); } catch (error) { outcome = { status: "blocked", reason: error instanceof Error ? error.message : String(error) }; }
        state.tickets[ticketId] = { ...state.tickets[ticketId], ...outcome, settledAt: new Date().toISOString() }; save(directory, state); return [ticketId, outcome];
      })();
      running.set(ticketId, promise); promise.finally(() => running.delete(ticketId));
    };
    try {
      while (true) {
        if (state.stopRequested) launchBlocked = true;
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
