import fs from "node:fs";
import path from "node:path";
import { validateOwnedPaths, validateRelativePath, validateRequestId, validateRunId, validateTicketId, pathsOverlap } from "./contracts.mjs";
import { sha256 } from "./git-evidence.mjs";
import { acquireRunnerLock, atomicWriteJson, readJson, releaseRunnerLock, writeReceipt } from "./state.mjs";

const SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const TICKET_STATES = new Set(["ready", "allocating", "active", "validating", "review", "needs_fix", "stopping", "stopped", "stop_unconfirmed", "done", "awaiting_integration", "blocked"]);
const PHASES = new Set(["ready", "active", "awaiting_integration", "blocked", "stopping", "stopped", "stop_unconfirmed", "done"]);
const REQUEST_ACTIONS = new Set(["steer", "reply", "continue", "stop"]);
const WIDENING = /\b(dependenc(?:y|ies)|ownership|owned paths?|scope|product|architecture|model|migration|publish(?:ing|ation)?|deploy(?:ment)?|release)\b/i;

function plain(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be a plain object.`);
  return value;
}

function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) freeze(child);
  return Object.freeze(value);
}

function sha(value, label) {
  if (typeof value !== "string" || !SHA.test(value)) throw new TypeError(`${label} must be a lowercase Git object ID.`);
  return value;
}

function ticketId(value) { return validateTicketId(value); }

export function validateTicketGraph(tickets) {
  if (!Array.isArray(tickets) || tickets.length === 0 || tickets.length > 256) throw new TypeError("tickets must contain 1 through 256 tickets.");
  const normalized = tickets.map((value, index) => {
    plain(value, `tickets[${index}]`);
    const id = ticketId(value.id);
    if (!Array.isArray(value.dependencies) || value.dependencies.length > 256) throw new TypeError(`${id}.dependencies must be an array.`);
    const dependencies = value.dependencies.map(ticketId);
    if (new Set(dependencies).size !== dependencies.length || dependencies.includes(id)) throw new Error(`${id} has duplicate or self dependencies.`);
    if (!Number.isSafeInteger(value.batch) || value.batch < 1) throw new TypeError(`${id}.batch must be a positive integer.`);
    const ownedPaths = validateOwnedPaths(value.ownedPaths ?? value.ownedFiles).map((entry) => `${entry.path}${entry.directory ? "/" : ""}`);
    const worktreePath = typeof value.worktreePath === "string" && path.isAbsolute(value.worktreePath) && path.normalize(value.worktreePath) === value.worktreePath ? value.worktreePath : (() => { throw new TypeError(`${id}.worktreePath must be a normalized absolute path.`); })();
    plain(value.worker, `${id}.worker`);
    if (typeof value.worker.name !== "string" || !value.worker.name || typeof value.worker.pane !== "string" || !value.worker.pane) throw new TypeError(`${id}.worker requires name and pane.`);
    return { ...value, id, dependencies, batch: value.batch, ownedPaths, worktreePath, worker: { ...value.worker } };
  });
  const byId = new Map();
  for (const ticket of normalized) {
    if (byId.has(ticket.id)) throw new Error(`duplicate ticket ID: ${ticket.id}`);
    byId.set(ticket.id, ticket);
  }
  for (const ticket of normalized) for (const dependency of ticket.dependencies) {
    const predecessor = byId.get(dependency);
    if (!predecessor) throw new Error(`${ticket.id} depends on unknown ticket ${dependency}.`);
    if (predecessor.batch >= ticket.batch) throw new Error(`${ticket.id} batch must be later than dependency ${dependency}.`);
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new Error(`ticket dependency cycle includes ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const ticket of normalized) visit(ticket.id);
  for (let left = 0; left < normalized.length; left += 1) for (let right = left + 1; right < normalized.length; right += 1) {
    const a = normalized[left];
    const b = normalized[right];
    if (a.batch !== b.batch) continue;
    if (a.worktreePath === b.worktreePath) throw new Error(`concurrent tickets ${a.id} and ${b.id} share a worktree.`);
    if (a.ownedPaths.some((owned) => b.ownedPaths.some((other) => pathsOverlap(owned, other)))) throw new Error(`concurrent tickets ${a.id} and ${b.id} have overlapping ownership.`);
  }
  return freeze(normalized);
}

export function readyTickets(tickets, states) {
  const graph = validateTicketGraph(tickets);
  plain(states, "states");
  return graph.filter((ticket) => states[ticket.id]?.status === "ready" && ticket.dependencies.every((dependency) => states[dependency]?.status === "done" || states[dependency]?.status === "awaiting_integration")).map((ticket) => ticket.id).sort();
}

async function run(processRunner, executable, args, cwd, acceptable = [0]) {
  const result = await processRunner.run({ executable, args, cwd });
  if (!result || !acceptable.includes(result.code) || result.signal || result.timedOut || result.outputLimit) throw new Error(`${executable} ${args.join(" ")} failed.`);
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
}

export async function verifyIntegration(input, deps = {}) {
  plain(input, "integration input");
  const repositoryPath = input.repositoryPath;
  if (typeof repositoryPath !== "string" || !path.isAbsolute(repositoryPath)) throw new TypeError("repositoryPath must be absolute.");
  const previousBaseSha = sha(input.previousBaseSha, "previousBaseSha");
  const integratedSha = sha(input.integratedSha, "integratedSha");
  if (!Array.isArray(input.manifests) || input.manifests.length === 0) throw new TypeError("manifests must be a non-empty array.");
  const processRunner = deps.processRunner;
  if (!processRunner?.run) throw new TypeError("processRunner.run is required.");
  const verifiedPaths = [];
  const verifySnapshot = async () => {
    const status = await run(processRunner, "git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], repositoryPath);
    if (status.length) throw new Error("integration checkout must be clean.");
    const head = (await run(processRunner, "git", ["rev-parse", "HEAD"], repositoryPath)).toString("utf8").trim();
    if (head !== integratedSha) throw new Error(`integration checkout HEAD mismatch: expected ${integratedSha}, found ${head}.`);
    await run(processRunner, "git", ["merge-base", "--is-ancestor", previousBaseSha, integratedSha], repositoryPath);
    for (const manifest of input.manifests) {
      plain(manifest, "manifest");
      plain(manifest.pathHashes, "manifest.pathHashes");
      for (const [file, expected] of Object.entries(manifest.pathHashes)) {
        validateRelativePath(file, { allowDirectoryPrefix: false });
        if (!/^[0-9a-f]{64}$/.test(expected)) throw new TypeError(`invalid path hash for ${file}.`);
        const absent = sha256(`absent\0${file}`);
        const entry = await run(processRunner, "git", ["ls-tree", "-z", integratedSha, "--", file], repositoryPath);
        if (entry.length === 0) {
          if (expected !== absent) throw new Error(`integrated path is missing: ${file}`);
          verifiedPaths.push(file); continue;
        }
        const match = entry.toString("utf8").match(/^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/);
        if (!match || match[3] !== file) throw new Error(`integrated path type or identity mismatch: ${file}`);
        if (expected === absent) throw new Error(`integrated path expected absent but exists: ${file}`);
        const bytes = await run(processRunner, "git", ["cat-file", "blob", match[2]], repositoryPath);
        if (sha256(bytes) !== expected) throw new Error(`integrated path hash mismatch: ${file}`);
        verifiedPaths.push(file);
      }
    }
  };
  await verifySnapshot();
  if (!input.validation || typeof input.validation.executable !== "string" || !Array.isArray(input.validation.args)) throw new TypeError("validation must be an argv command.");
  let validationCwd = repositoryPath;
  if (input.validation.cwd) {
    const relative = validateRelativePath(input.validation.cwd, { allowDirectoryPrefix: false });
    validationCwd = path.resolve(repositoryPath, ...relative.split("/"));
    const realRepository = fs.realpathSync(repositoryPath);
    const realValidationCwd = fs.realpathSync(validationCwd);
    if (realValidationCwd !== realRepository && !realValidationCwd.startsWith(`${realRepository}${path.sep}`)) throw new Error("validation cwd escapes repository.");
    validationCwd = realValidationCwd;
  }
  await run(processRunner, input.validation.executable, input.validation.args, validationCwd);
  await verifySnapshot();
  return freeze({ previousBaseSha, integratedSha, verifiedPaths: [...new Set(verifiedPaths)].sort(), validation: { executable: input.validation.executable, args: [...input.validation.args] } });
}

export function reconcileRunner(runtimeDir, { isProcessAlive } = {}) {
  const lockPath = path.join(runtimeDir, "runner.lock");
  const runnerPath = path.join(runtimeDir, "runner.json");
  const exists = (file) => { try { return fs.lstatSync(file).isFile(); } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
  const lockExists = exists(lockPath);
  const runnerExists = exists(runnerPath);
  if (!lockExists && !runnerExists) return Object.freeze({ status: "available" });
  if (!lockExists || !runnerExists) return Object.freeze({ status: "blocked", reason: "runner ownership evidence is incomplete" });
  let lock;
  let runner;
  try { lock = readJson(lockPath); runner = readJson(runnerPath); } catch { return Object.freeze({ status: "blocked", reason: "runner ownership evidence is unreadable" }); }
  if (!lock || !runner || lock.version !== 1 || runner.version !== 1 || lock.runId !== runner.runId || lock.pid !== runner.pid || lock.ownershipToken !== runner.ownershipToken || !/^[0-9a-f]{64}$/.test(runner.ownershipToken ?? "")) return Object.freeze({ status: "blocked", reason: "runner ownership evidence is ambiguous" });
  if (typeof isProcessAlive !== "function") return Object.freeze({ status: "blocked", reason: "runner owner liveness is unknown", owner: freeze({ ...runner }) });
  let alive;
  try { alive = isProcessAlive(freeze({ ...runner })); } catch { alive = undefined; }
  if (alive !== false) return Object.freeze({ status: "blocked", reason: alive ? "runner owner is live" : "runner owner liveness is unknown", owner: freeze({ ...runner }) });
  return Object.freeze({ status: "stale", owner: freeze({ ...runner }) });
}

function validateState(value) {
  plain(value, "scheduler state");
  if (value.version !== 1 || !PHASES.has(value.phase) || !SHA.test(value.baseSha) || typeof value.runId !== "string" || !Array.isArray(value.completedSteps) || typeof value.nextAction !== "string") throw new Error("scheduler state is invalid.");
  validateRunId(value.runId);
  plain(value.tickets, "scheduler state tickets");
  for (const [id, ticket] of Object.entries(value.tickets)) {
    ticketId(id); plain(ticket, `ticket ${id}`);
    if (!TICKET_STATES.has(ticket.status) || !Number.isSafeInteger(ticket.attempt) || ticket.attempt < 0) throw new Error(`ticket state is invalid: ${id}.`);
  }
  return value;
}

function validateRequest(value, runId) {
  plain(value, "control request");
  const allowed = ["version", "requestId", "runId", "action", "ticketId", "message", "integratedSha", "createdAt"];
  if (Object.keys(value).some((key) => !allowed.includes(key)) || value.version !== 1 || validateRunId(value.runId) !== runId || !REQUEST_ACTIONS.has(value.action)) throw new TypeError("control request is invalid.");
  validateRequestId(value.requestId);
  if (value.ticketId !== undefined) ticketId(value.ticketId);
  if (value.message !== undefined && (typeof value.message !== "string" || !value.message.trim() || value.message.length > 16_000 || value.message.includes("\0"))) throw new TypeError("control request message is invalid.");
  if (["steer", "reply"].includes(value.action) && (!value.ticketId || !value.message)) throw new TypeError(`${value.action} requires ticketId and message.`);
  if (value.action === "continue") sha(value.integratedSha, "integratedSha");
  return value;
}

export function createScheduler({ repositoryPath, runtimeDir, runTicket, processRunner, herdr, clock = () => new Date(), isProcessAlive = () => undefined, runnerOwner, runnerLockHeld = false, maxConcurrency = 4 } = {}) {
  if (!path.isAbsolute(repositoryPath ?? "") || !path.isAbsolute(runtimeDir ?? "")) throw new TypeError("repositoryPath and runtimeDir must be absolute.");
  if (typeof runTicket !== "function" || !processRunner?.run || !herdr) throw new TypeError("runTicket, processRunner, and herdr are required.");
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 8) throw new TypeError("maxConcurrency must be an integer from 1 through 8.");
  const statePath = path.join(runtimeDir, "state.json");
  const inboxPath = path.join(runtimeDir, "inbox");
  const processingPath = path.join(runtimeDir, "processing");
  const receiptsPath = path.join(runtimeDir, "receipts");
  const load = () => validateState(readJson(statePath));
  const save = (state) => atomicWriteJson(statePath, { ...state, updatedAt: clock().toISOString() });
  const graphFor = (tickets) => validateTicketGraph(tickets);
  let stateQueue = Promise.resolve();
  const updateState = (change) => {
    const pending = stateQueue.then(() => {
      const state = load();
      const result = change(state);
      save(state);
      return { state, result };
    });
    stateQueue = pending.then(() => undefined, () => undefined);
    return pending;
  };

  async function startBatch(tickets) {
    const graph = graphFor(tickets);
    const prepared = await updateState((state) => {
      if (state.phase !== "ready") return [];
      const ids = readyTickets(graph, state.tickets);
      if (!ids.length) return [];
      const selected = graph.filter((ticket) => ids.includes(ticket.id));
      const batch = Math.min(...selected.map((ticket) => ticket.batch));
      const launching = selected.filter((ticket) => ticket.batch === batch);
      for (const ticket of launching) state.tickets[ticket.id] = { ...state.tickets[ticket.id], status: "active", attempt: state.tickets[ticket.id].attempt + 1, agent: { name: `${ticket.worker.name}-${state.runId}`, pane: ticket.worker.pane }, worktree: ticket.worktreePath };
      state.phase = "active";
      state.nextAction = `settle batch ${batch}`;
      return launching;
    });
    const launching = prepared.result;
    if (!launching.length) return freeze({ status: "idle", ticketIds: [] });
    const settled = new Array(launching.length);
    let next = 0;
    const worker = async () => {
      while (next < launching.length) {
        const index = next++;
        const ticket = launching[index];
        try {
          const result = await runTicket(ticket);
          const hashes = result?.manifest && plain(result.manifest, "runner manifest").pathHashes;
          const validManifest = result?.status === "done" && hashes && Object.getPrototypeOf(hashes) === Object.prototype && Object.keys(hashes).length > 0;
          await updateState((state) => {
            const current = state.tickets[ticket.id];
            if (["stopping", "stopped", "stop_unconfirmed"].includes(current.status)) return;
            state.tickets[ticket.id] = validManifest ? { ...current, status: "done", manifest: result.manifest } : { ...current, status: "blocked", reason: result?.status === "done" ? "runner done result lacks nonempty manifest pathHashes" : result?.reason ?? "runner did not return done" };
          });
          settled[index] = { id: ticket.id, result };
        } catch (error) {
          await updateState((state) => {
            const current = state.tickets[ticket.id];
            if (!["stopping", "stopped", "stop_unconfirmed"].includes(current.status)) state.tickets[ticket.id] = { ...current, status: "blocked", reason: error instanceof Error ? error.message : String(error) };
          });
          settled[index] = { id: ticket.id, error };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(maxConcurrency, launching.length) }, worker));
    const final = await updateState((state) => {
      if (["stopping", "stopped", "stop_unconfirmed"].includes(state.phase)) return state.phase;
      const failed = launching.some((ticket) => state.tickets[ticket.id].status !== "done");
      state.phase = failed ? "blocked" : "awaiting_integration";
      state.nextAction = failed ? "resolve blocked ticket" : "integrate completed batch";
      return state.phase;
    });
    return freeze({ status: final.result, ticketIds: launching.map((ticket) => ticket.id), settled });
  }

  async function continueIntegration(input, tickets) {
    const snapshot = load();
    if (snapshot.phase !== "awaiting_integration") throw new Error("integration continuation requires awaiting_integration.");
    const integratedSha = typeof input === "string" ? input : input?.integratedSha;
    const validation = typeof input === "object" ? input.validation : undefined;
    const completed = Object.entries(snapshot.tickets).filter(([, value]) => value.status === "done" && value.manifest).map(([, value]) => value.manifest);
    const evidence = await verifyIntegration({ previousBaseSha: snapshot.baseSha, integratedSha, manifests: completed, repositoryPath, validation }, { processRunner });
    const graph = tickets ? graphFor(tickets) : undefined;
    await updateState((state) => {
      if (state.phase !== "awaiting_integration" || state.baseSha !== snapshot.baseSha) throw new Error("scheduler state changed during integration verification.");
      const step = `integrated:${state.baseSha}:${integratedSha}`;
      if (!state.completedSteps.includes(step)) state.completedSteps.push(step);
      state.baseSha = integratedSha;
      for (const [id, value] of Object.entries(state.tickets)) if (value.status === "done") state.tickets[id] = { ...value, status: "awaiting_integration" };
      if (graph) {
        for (const ticket of graph) if (state.tickets[ticket.id]?.status === "ready" && ticket.dependencies.every((id) => ["done", "awaiting_integration"].includes(state.tickets[id]?.status))) state.tickets[ticket.id] = { ...state.tickets[ticket.id], status: "ready" };
        state.phase = readyTickets(graph, state.tickets).length ? "ready" : Object.values(state.tickets).every((value) => ["done", "awaiting_integration"].includes(value.status)) ? "done" : "blocked";
      } else state.phase = "ready";
      state.nextAction = state.phase === "ready" ? "start dependency-ready batch" : state.phase === "done" ? "final acceptance" : "resolve scheduler state";
    });
    return evidence;
  }

  async function stopTicket(_state, ticketIdValue) {
    const marked = await updateState((state) => {
      const candidates = Object.entries(state.tickets).filter(([id, value]) => (!ticketIdValue || id === ticketIdValue) && ["active", "allocating", "validating", "review", "needs_fix"].includes(value.status));
      if (!candidates.length) throw new Error("no matching live ticket to stop.");
      state.phase = "stopping";
      for (const [id, value] of candidates) state.tickets[id] = { ...value, status: "stopping" };
      state.nextAction = "confirm agent stop";
      return candidates.map(([id, value]) => ({ id, agent: value.agent }));
    });
    let confirmed = true;
    for (const { agent } of marked.result) {
      if (!agent?.name) { confirmed = false; continue; }
      try {
        await herdr.agentSendKeys({ target: agent.name, keys: ["C-c"] });
        const observed = await herdr.agentWait({ target: agent.name, until: ["done", "blocked", "idle"], timeout: 30_000 });
        const status = observed?.agent?.status ?? observed?.status;
        if (!["done", "blocked", "idle"].includes(status)) confirmed = false;
      } catch { confirmed = false; }
    }
    const final = await updateState((state) => {
      state.phase = confirmed ? "stopped" : "stop_unconfirmed";
      for (const { id } of marked.result) state.tickets[id] = { ...state.tickets[id], status: state.phase };
      state.nextAction = confirmed ? "operator may inspect retained worktrees" : "operator must confirm agent stop";
      return state.phase;
    });
    return final.result;
  }

  // T005 extension wiring must serialize processInbox calls; this internal API does not arbitrate concurrent consumers.
  async function processInbox(options = {}) {
    fs.mkdirSync(inboxPath, { recursive: true, mode: 0o700 });
    fs.mkdirSync(processingPath, { recursive: true, mode: 0o700 });
    fs.mkdirSync(receiptsPath, { recursive: true, mode: 0o700 });
    const receipts = [];
    for (const name of fs.readdirSync(processingPath).filter((file) => file.endsWith(".json")).sort()) {
      const requestId = path.basename(name, ".json");
      if (fs.existsSync(path.join(receiptsPath, `${requestId}.json`))) continue;
      const receipt = { version: 1, requestId, status: "failed", action: "unknown", reason: "runner restarted after request claim; effect is not replayed", createdAt: clock().toISOString() };
      writeReceipt(receiptsPath, receipt);
      receipts.push(freeze(receipt));
    }
    for (const name of fs.readdirSync(inboxPath).filter((file) => file.endsWith(".json")).sort()) {
      const source = path.join(inboxPath, name);
      const claimed = path.join(processingPath, name);
      const fileRequestId = path.basename(name, ".json");
      if (fs.existsSync(path.join(receiptsPath, `${fileRequestId}.json`))) continue;
      try { fs.linkSync(source, claimed); fs.unlinkSync(source); } catch (error) { if (error.code === "ENOENT" || error.code === "EEXIST") continue; throw error; }
      let request;
      let receipt;
      try {
        const state = load();
        request = validateRequest(readJson(claimed), state.runId);
        if (request.requestId !== fileRequestId) throw new Error("request filename must equal requestId.");
        const ticket = request.ticketId ? state.tickets[request.ticketId] : undefined;
        if (request.ticketId && !ticket) throw new Error("ticket is unknown.");
        if (request.action === "steer") {
          if (!ticket.agent?.name || ticket.status !== "active") throw new Error("ticket has no exact live agent.");
          await herdr.agentPrompt({ target: ticket.agent.name, prompt: request.message, wait: false });
        } else if (request.action === "reply") {
          if (ticket.status !== "blocked" || typeof ticket.question !== "string" || !ticket.question) throw new Error("reply requires blocked ticket with existing question.");
          if (WIDENING.test(request.message)) throw new Error("reply widens approved scope.");
          if (!ticket.agent?.name) throw new Error("ticket has no exact retained agent.");
          await herdr.agentPrompt({ target: ticket.agent.name, prompt: request.message, wait: false });
        } else if (request.action === "continue") {
          await continueIntegration({ integratedSha: request.integratedSha, validation: options.validation }, options.tickets);
        } else await stopTicket(state, request.ticketId);
        receipt = { version: 1, requestId: request.requestId, status: "applied", action: request.action, ...(request.ticketId ? { ticketId: request.ticketId } : {}), createdAt: clock().toISOString() };
      } catch (error) {
        const requestId = request?.requestId ?? path.basename(name, ".json");
        receipt = { version: 1, requestId, status: request ? "rejected" : "failed", action: request?.action ?? "unknown", ...(request?.ticketId ? { ticketId: request.ticketId } : {}), reason: error instanceof Error ? error.message : String(error), createdAt: clock().toISOString() };
      }
      writeReceipt(receiptsPath, receipt);
      receipts.push(freeze(receipt));
    }
    return freeze(receipts);
  }

  async function recover(options = {}) {
    if (!runnerOwner) throw new Error("runnerOwner is required for recovery lock ownership.");
    const lockPath = path.join(runtimeDir, "runner.lock");
    const owner = runnerLockHeld ? runnerOwner : acquireRunnerLock(lockPath, runnerOwner, { isOwnerAlive: isProcessAlive });
    try {
      const state = load();
      if (state.runId !== owner.runId) throw new Error("recovery lock runId does not match scheduler state.");
      if (state.phase === "stopping") {
        state.phase = "stop_unconfirmed";
        for (const [id, ticket] of Object.entries(state.tickets)) if (ticket.status === "stopping") state.tickets[id] = { ...ticket, status: "stop_unconfirmed" };
        state.nextAction = "operator must confirm agent stop";
        save(state);
        return freeze({ status: "stop_unconfirmed", recovered: [] });
      }
      if (state.phase !== "active") return freeze({ status: state.phase, recovered: [] });
      const recovered = [];
      for (const [id, ticket] of Object.entries(state.tickets)) {
        if (!["active", "validating", "review", "needs_fix"].includes(ticket.status)) continue;
        if (!ticket.agent?.name || !ticket.agent?.pane || !ticket.worktree || !path.isAbsolute(ticket.worktree)) {
          state.tickets[id] = { ...ticket, status: "blocked", reason: "recovery identity is ambiguous" }; continue;
        }
        const step = `recovered:${id}:${ticket.attempt}`;
        if (state.completedSteps.includes(step)) continue;
        if (typeof options.recoverTicket !== "function") { state.tickets[id] = { ...ticket, status: "blocked", reason: "exact runner recovery seam is unavailable" }; continue; }
        const result = await options.recoverTicket(id, freeze({ ...ticket }));
        state.completedSteps.push(step);
        recovered.push(id);
        if (result?.status === "done") state.tickets[id] = { ...ticket, status: "done", manifest: result.manifest };
        else if (result?.status === "recovered") state.tickets[id] = { ...ticket, status: ticket.status };
        else state.tickets[id] = { ...ticket, status: "blocked", reason: result?.reason ?? "recovery failed" };
      }
      state.phase = Object.values(state.tickets).some((ticket) => ticket.status === "blocked") ? "blocked" : Object.values(state.tickets).some((ticket) => ["active", "validating", "review", "needs_fix"].includes(ticket.status)) ? "active" : "awaiting_integration";
      state.nextAction = state.phase === "blocked" ? "resolve recovery block" : state.phase === "active" ? "wait for exact retained agents" : "integrate completed batch";
      save(state);
      return freeze({ status: state.phase, recovered });
    } finally {
      if (!runnerLockHeld) releaseRunnerLock(lockPath, owner);
    }
  }

  return Object.freeze({ startBatch, processInbox, continueIntegration, recover });
}
