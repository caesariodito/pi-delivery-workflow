import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
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
function atomicJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const temporary = `${file}.${process.pid}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temporary, file); }
function readJson(file, maximum = 256 * 1024) { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new Error("inspection file is invalid."); return JSON.parse(fs.readFileSync(file, "utf8")); }
function runDir(repositoryPath, runId) { return path.join(repositoryPath, ".scratch", "delivery", safeId(runId, "runId")); }
function git(repositoryPath, args) { return new Promise((resolve, reject) => execFile("git", args, { cwd: repositoryPath, env: buildChildEnvironment(), encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 30_000, shell: false }, (error, stdout, stderr) => error ? reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`)) : resolve(stdout))); }
function command(spec, worktreePath) { const cwd = fs.realpathSync(path.resolve(worktreePath, spec.cwd ?? ".")); const root = fs.realpathSync(worktreePath); if (cwd !== root && !inside(root, cwd)) throw new Error("validation cwd escapes worktree."); return new Promise((resolve) => execFile(spec.executable, spec.args, { cwd, env: buildChildEnvironment(), encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 300_000, shell: false }, (error, stdout, stderr) => resolve({ passed: !error, code: error?.code ?? 0, stdout, stderr }))); }
function statePath(directory) { return path.join(directory, "status.json"); }
function save(directory, state) { state.updatedAt = new Date().toISOString(); atomicJson(statePath(directory), state); return state; }
function contextFilesExist(repositoryPath, paths) { for (const item of paths) { const resolved = path.resolve(repositoryPath, item); const stat = fs.lstatSync(resolved); if (!inside(repositoryPath, resolved) || !stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error(`context file is unavailable: ${item}`); } }
function parseAgentState(value) { return value?.agent?.agent_status ?? value?.agent?.status ?? value?.agent?.state ?? value?.event?.agent_status ?? value?.status ?? value?.state ?? "unknown"; }

async function verifyRepository(repositoryPath, baseSha, worktreeRoot, herdr) {
  if (process.env.HERDR_ENV !== "1") throw new Error("HERDR_ENV=1 is required.");
  await herdr.status(); const integrations = await herdr.integrationStatus(); if (!integrations.some((entry) => entry.name === "pi" && entry.status.startsWith("current (v"))) throw new Error("Herdr Pi integration is not current.");
  const root = fs.realpathSync(repositoryPath); const top = (await git(root, ["rev-parse", "--show-toplevel"])).trim();
  if (fs.realpathSync(top) !== root) throw new Error("cwd must be repository root.");
  if ((await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length) throw new Error("parent checkout must be clean.");
  const resolved = (await git(root, ["rev-parse", "--verify", `${baseSha}^{commit}`])).trim(); if (resolved !== baseSha) throw new Error("baseSha must be exact immutable commit.");
  await git(root, ["check-ignore", "-q", ".scratch/"]);
  if (!path.isAbsolute(worktreeRoot) || path.normalize(worktreeRoot) !== worktreeRoot) throw new Error("worktreeRoot must be normalized and absolute.");
  fs.mkdirSync(worktreeRoot, { recursive: true, mode: 0o700 }); const worktreeReal = fs.realpathSync(worktreeRoot); const stat = fs.lstatSync(worktreeRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || worktreeReal === root || worktreeReal.startsWith(`${root}${path.sep}`)) throw new Error("worktreeRoot must be a real directory outside repository.");
  return root;
}

function owned(ticket, file) { return ticket.ownedPaths.some((claim) => claim.endsWith("/") ? file.startsWith(claim) : file === claim); }
function handoff(ticket, runtime, worktreePath, branch, agentResult, validation, changes) {
  return { version: 1, ticketId: ticket.id, status: agentResult.status, summary: agentResult.summary, handoff: agentResult.handoff, question: agentResult.question ?? null, branch, worktreePath, changedPaths: changes, validation, promptPath: runtime.promptPath, resultPath: runtime.resultPath, createdAt: new Date().toISOString() };
}

export function createDeliveryWorkflowCore({ herdr = createHerdrAdapter({ env: buildChildEnvironment() }), nonce = () => randomBytes(24).toString("hex") } = {}) {
  async function executeTicket(repositoryPath, directory, run, ticket, state, worktreeRoot) {
    const ticketDir = path.join(directory, "tickets", ticket.id); fs.mkdirSync(ticketDir, { recursive: true, mode: 0o700 });
    const worktreePath = path.join(worktreeRoot, `${run.runId}-${ticket.id}`); const branch = `delivery/${run.runId}-${ticket.id}`;
    const created = await herdr.worktreeCreate({ cwd: repositoryPath, branch, base: run.baseSha, path: worktreePath, label: `${run.runId} ${ticket.id}`, focus: false });
    if (path.resolve(created.path) !== path.resolve(worktreePath) || typeof created.pane !== "string") throw new Error("Herdr returned unexpected worktree or pane.");
    const promptPath = path.join(directory, "prompts", `${ticket.id}.md`); const resultPath = path.join(directory, "results", `${ticket.id}.json`); const ticketNonce = nonce();
    const dependencyHandoffs = ticket.dependencies.map((dependency) => ({ ticketId: dependency, handoff: state.tickets[dependency].handoff }));
    const packet = buildContextPacket({ run, ticket, repositoryPath, worktreePath, promptPath, resultPath, nonce: ticketNonce, dependencyHandoffs, guidance: state.guidance?.[ticket.id] ?? "" });
    fs.mkdirSync(path.dirname(promptPath), { recursive: true, mode: 0o700 }); fs.mkdirSync(path.dirname(resultPath), { recursive: true, mode: 0o700 }); fs.writeFileSync(promptPath, packet, { mode: 0o600, flag: "wx" });
    const target = ticket.worker.name; const tools = [...new Set([...ticket.worker.tools, RESULT_TOOL])];
    state.tickets[ticket.id] = { status: "running", target, pane: created.pane, worktreePath, branch, promptPath, resultPath, startedAt: new Date().toISOString() }; save(directory, state);
    await herdr.agentStart({ name: target, kind: ticket.worker.kind, pane: created.pane, timeout: 300_000, agentArgs: ["--model", ticket.worker.model, "--thinking", ticket.worker.thinking, "--extension", RESULT_EXTENSION, "--delivery-result-path", resultPath, "--delivery-result-nonce", ticketNonce, "--tools", tools.join(",")] });
    const promptResult = await herdr.agentPrompt({ target, prompt: `Read and follow the complete ticket context at ${promptPath}. Call ${RESULT_TOOL} exactly once when settled.`, wait: true, timeout: 300_000 });
    let status = parseAgentState(promptResult);
    if (status === "unknown" || !fs.existsSync(resultPath)) { const live = await herdr.agentGet(target); status = parseAgentState(live); }
    if (!["idle", "done", "blocked"].includes(status)) throw new Error(`agent settled in unknown state ${status}.`);
    if (!fs.existsSync(resultPath)) throw new Error(status === "blocked" ? "agent blocked without result file." : "agent settled without result file.");
    const agentResult = validateTicketResult(readJson(resultPath, 64 * 1024), ticket.id);
    if (agentResult.status !== "done") return { status: agentResult.status, reason: agentResult.summary, question: agentResult.question ?? null, handoff: agentResult.handoff ?? "", target, pane: created.pane, worktreePath, branch, promptPath, resultPath };
    if (agentResult.validation === "failed") return { status: "failed", reason: "agent reported failed validation", target, pane: created.pane, worktreePath, branch, promptPath, resultPath };
    const validation = await command(ticket.validation, worktreePath); fs.mkdirSync(path.join(directory, "logs"), { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(directory, "logs", `${ticket.id}.log`), `${validation.stdout}${validation.stderr}`, { mode: 0o600 });
    const head = (await git(worktreePath, ["rev-parse", "HEAD"])).trim(); if (head !== run.baseSha) return { status: "blocked", reason: "worker committed or moved HEAD; only working-tree changes are accepted", target, pane: created.pane, worktreePath, branch, promptPath, resultPath };
    const changes = parsePorcelainV1Z(await git(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])); const violations = changes.filter((file) => !owned(ticket, file));
    if (violations.length) return { status: "blocked", reason: `ownership violation: ${violations.join(", ")}`, target, pane: created.pane, worktreePath, branch, promptPath, resultPath };
    if (!validation.passed) return { status: "failed", reason: "validation failed", target, pane: created.pane, worktreePath, branch, promptPath, resultPath, validation };
    const value = handoff(ticket, { promptPath, resultPath }, worktreePath, branch, agentResult, { passed: true, executable: ticket.validation.executable, args: ticket.validation.args }, changes); atomicJson(path.join(directory, "handoffs", `${ticket.id}.json`), value); return { status: "done", ...value };
  }

  async function run(repositoryPath, input, existing = false) {
    const run = validateRunInput(input); const root = await verifyRepository(repositoryPath, run.baseSha, input.worktreeRoot, herdr); contextFilesExist(root, [...run.contextPaths, ...run.tickets.flatMap((ticket) => ticket.specPaths)]);
    const directory = runDir(root, run.runId); if (!existing) { fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 }); fs.mkdirSync(directory, { recursive: false, mode: 0o700 }); atomicJson(path.join(directory, "run.json"), { ...run, worktreeRoot: input.worktreeRoot, createdAt: new Date().toISOString() }); }
    const state = existing ? readJson(statePath(directory)) : { version: 1, runId: run.runId, baseSha: run.baseSha, phase: "running", tickets: Object.fromEntries(run.tickets.map((ticket) => [ticket.id, { status: "pending" }])), guidance: {}, updatedAt: new Date().toISOString() };
    active.set(directory, { state, run });
    try {
      while (true) {
        if (state.stopRequested) { state.phase = "stopped"; state.nextAction = "Inspect retained Herdr panes/worktrees."; save(directory, state); break; }
        const ready = readyTickets(run.tickets, state.tickets); if (!ready.length) break;
        const batch = ready.slice(0, run.maxConcurrency); const outcomes = await Promise.all(batch.map(async (ticketId) => { const ticket = run.tickets.find((item) => item.id === ticketId); let outcome; try { outcome = await executeTicket(root, directory, run, ticket, state, input.worktreeRoot); } catch (error) { outcome = { status: "blocked", reason: error instanceof Error ? error.message : String(error) }; } state.tickets[ticketId] = { ...state.tickets[ticketId], ...outcome }; save(directory, state); return [ticketId, outcome]; }));
        if (state.stopRequested) { state.phase = "stopped"; state.nextAction = "Inspect retained Herdr panes/worktrees."; save(directory, state); break; }
        if (outcomes.some(([, outcome]) => outcome.status !== "done")) { state.phase = "blocked"; state.nextAction = "Inspect retained Herdr pane/worktree and resolve blocker."; save(directory, state); break; }
      }
      if (state.phase !== "blocked") { const pending = Object.values(state.tickets).some((ticket) => ticket.status === "pending"); state.phase = pending && blockedByIntegration(run.tickets, state.tickets) ? "awaiting_integration" : pending ? "blocked" : "done"; state.nextAction = state.phase === "awaiting_integration" ? "Parent integrates completed dependency work and calls delivery_continue with new base SHA." : state.phase === "done" ? "Parent inspects and integrates handoffs." : "Inspect dependency state."; save(directory, state); }
      return state;
    } finally { active.delete(directory); }
  }

  return Object.freeze({
    async start(repositoryPath, input) { const state = await run(repositoryPath, input, false); return result(`Delivery ${input.runId}: ${state.phase}.`, state, state.phase === "blocked"); },
    async status(repositoryPath, input) { const directory = runDir(repositoryPath, input.runId); if (!fs.existsSync(statePath(directory))) return result(`Run ${input.runId} not found.`, { status: "not_found" }, true); return result(`Delivery ${input.runId}: ${readJson(statePath(directory)).phase}.`, readJson(statePath(directory))); },
    async steer(repositoryPath, input) { const directory = runDir(repositoryPath, input.runId); const running = active.get(directory); if (!running) return result("Run is not active in this Pi process; inspect Herdr and start a new supervised run if needed.", { status: "not_active" }, true); const ticket = running.state.tickets[safeId(input.ticketId, "ticketId")]; if (ticket?.status !== "running" || !ticket.target) return result("Ticket has no active target.", { status: "not_active" }, true); const liveState = parseAgentState(await herdr.agentGet(ticket.target)); if (liveState !== "working") return result(`Ticket agent is ${liveState}; guidance not sent.`, { status: "not_active", agentState: liveState }, true); await herdr.agentPrompt({ target: ticket.target, prompt: input.message, wait: false, timeout: 30_000 }); return result("Guidance sent; delivery is not proof of compliance.", { status: "sent", target: ticket.target }); },
    async stop(repositoryPath, input) { const directory = runDir(repositoryPath, input.runId); const running = active.get(directory); const state = fs.existsSync(statePath(directory)) ? readJson(statePath(directory)) : null; const targets = input.ticketId ? [state?.tickets?.[input.ticketId]].filter((ticket) => ticket?.status === "running") : Object.values(state?.tickets ?? {}).filter((ticket) => ticket.status === "running"); if (!targets.length) return result("No active recorded ticket target.", { status: "not_active" }, true); for (const ticket of targets) if (ticket.target) await herdr.agentSendKeys({ target: ticket.target, keys: ["ctrl+c"] }); if (running) { running.state.stopRequested = true; running.state.nextAction = "Wait for active batch to settle; no new tickets will launch."; save(directory, running.state); } return result("Stop requested. No new batch will launch; pane/worktree retained.", { status: "stop_requested", targets: targets.map((ticket) => ticket.target) }); },
    async continue(repositoryPath, input) { const directory = runDir(repositoryPath, input.runId); if (active.has(directory)) return result("Run is already active.", { status: "active" }, true); const savedRun = readJson(path.join(directory, "run.json")); const state = readJson(statePath(directory)); if (state.phase !== "awaiting_integration") return result("Run is not awaiting integration.", { status: state.phase }, true); const root = fs.realpathSync(repositoryPath); if (input.integratedSha === state.baseSha || (await git(root, ["rev-parse", "HEAD"])).trim() !== input.integratedSha || (await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length) return result("Integrated SHA must be a new clean current parent HEAD.", { status: "blocked" }, true); try { await git(root, ["merge-base", "--is-ancestor", state.baseSha, input.integratedSha]); } catch { return result("Integrated SHA must descend from prior base SHA.", { status: "blocked" }, true); } for (const ticket of Object.values(state.tickets)) if (ticket.status === "done") ticket.integrated = true; savedRun.baseSha = input.integratedSha; state.baseSha = input.integratedSha; state.phase = "running"; save(directory, state); atomicJson(path.join(directory, "run.json"), savedRun); const next = await run(root, savedRun, true); return result(`Delivery ${input.runId}: ${next.phase}.`, next, next.phase === "blocked"); },
  });
}
