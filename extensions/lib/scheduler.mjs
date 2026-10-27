import path from "node:path";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function text(value, label, maximum = 16_000) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) throw new TypeError(`${label} must be 1-${maximum} characters without NUL bytes.`);
  return value;
}
function id(value, label) { if (typeof value !== "string" || !ID.test(value)) throw new TypeError(`${label} must be a safe identifier.`); return value; }
function agentName(value, label) { if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(value)) throw new TypeError(`${label} must be a Herdr agent name.`); return value; }
function relative(value, label, directory = false) {
  text(value, label, 4096);
  if (path.isAbsolute(value) || value === "." || value.split(/[\\/]/).includes("..") || path.normalize(value) !== value) throw new TypeError(`${label} must be normalized and relative.`);
  if (directory && !value.endsWith("/")) throw new TypeError(`${label} directory prefix must end with /.`);
  return value;
}
function validationCwd(value, label) { return value === "." ? value : relative(value, label); }
function workerKind(value, label) {
  if (!["pi", "worker", "reviewer"].includes(value)) throw new TypeError(`${label} must be pi, worker, or reviewer.`);
  return "pi";
}
function command(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  const keys = Object.keys(value); if (keys.some((key) => !["executable", "args", "cwd"].includes(key))) throw new TypeError(`${label} has unknown properties.`);
  const executable = text(value.executable, `${label}.executable`, 1024);
  if (!Array.isArray(value.args) || value.args.length > 256 || value.args.some((arg) => typeof arg !== "string" || arg.length > 8192 || arg.includes("\0"))) throw new TypeError(`${label}.args is invalid.`);
  return Object.freeze({ executable, args: Object.freeze([...value.args]), ...(value.cwd ? { cwd: validationCwd(value.cwd, `${label}.cwd`) } : {}) });
}
function overlaps(left, right) {
  const a = left.endsWith("/") ? left : `${left}/`; const b = right.endsWith("/") ? right : `${right}/`;
  return left === right || a.startsWith(b) || b.startsWith(a);
}

export function validateTicketGraph(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new TypeError("tickets must contain 1-64 tickets.");
  const seen = new Set();
  const tickets = value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(`tickets[${index}] must be an object.`);
    const allowed = new Set(["id", "goal", "definitionOfDone", "dependencies", "ownedPaths", "forbiddenScope", "worker", "validation", "requiresIntegratedBase", "specPaths"]);
    if (Object.keys(raw).some((key) => !allowed.has(key))) throw new TypeError(`${raw.id ?? `tickets[${index}]`} has unknown properties.`);
    const ticketId = id(raw.id, `tickets[${index}].id`); if (seen.has(ticketId)) throw new TypeError(`duplicate ticket ${ticketId}.`); seen.add(ticketId);
    if (!Array.isArray(raw.dependencies) || raw.dependencies.length > 32) throw new TypeError(`${ticketId}.dependencies is invalid.`);
    if (!Array.isArray(raw.ownedPaths) || raw.ownedPaths.length === 0 || raw.ownedPaths.length > 64) throw new TypeError(`${ticketId}.ownedPaths is invalid.`);
    const worker = raw.worker;
    if (!worker || typeof worker !== "object" || Array.isArray(worker) || Object.keys(worker).some((key) => !["name", "kind", "model", "thinking", "tools"].includes(key))) throw new TypeError(`${ticketId}.worker is invalid.`);
    if (!Array.isArray(worker.tools) || worker.tools.length === 0 || worker.tools.length > 32) throw new TypeError(`${ticketId}.worker.tools is invalid.`);
    const normalized = {
      id: ticketId,
      goal: text(raw.goal, `${ticketId}.goal`),
      definitionOfDone: text(raw.definitionOfDone, `${ticketId}.definitionOfDone`),
      dependencies: Object.freeze(raw.dependencies.map((item) => id(item, `${ticketId}.dependency`))),
      ownedPaths: Object.freeze(raw.ownedPaths.map((item) => relative(item, `${ticketId}.ownedPath`, item.endsWith("/")))),
      forbiddenScope: text(raw.forbiddenScope ?? "Everything outside owned paths.", `${ticketId}.forbiddenScope`),
      worker: Object.freeze({ name: agentName(worker.name, `${ticketId}.worker.name`), kind: workerKind(worker.kind, `${ticketId}.worker.kind`), model: text(worker.model, `${ticketId}.worker.model`, 256), thinking: text(worker.thinking, `${ticketId}.worker.thinking`, 32), tools: Object.freeze(worker.tools.map((item) => id(item, `${ticketId}.worker.tool`))) }),
      validation: command(raw.validation, `${ticketId}.validation`),
      requiresIntegratedBase: raw.requiresIntegratedBase !== false,
      specPaths: Object.freeze((raw.specPaths ?? []).map((item) => relative(item, `${ticketId}.specPath`))),
    };
    return Object.freeze(normalized);
  });
  if (new Set(tickets.map((ticket) => ticket.worker.name)).size !== tickets.length) throw new TypeError("worker names must be unique.");
  for (const ticket of tickets) for (const dependency of ticket.dependencies) if (!seen.has(dependency) || dependency === ticket.id) throw new TypeError(`${ticket.id} has invalid dependency ${dependency}.`);
  const visiting = new Set(); const visited = new Set(); const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const visit = (ticketId) => { if (visiting.has(ticketId)) throw new TypeError("ticket graph has a cycle."); if (visited.has(ticketId)) return; visiting.add(ticketId); for (const dep of byId.get(ticketId).dependencies) visit(dep); visiting.delete(ticketId); visited.add(ticketId); };
  for (const ticket of tickets) visit(ticket.id);
  for (let i = 0; i < tickets.length; i += 1) for (let j = i + 1; j < tickets.length; j += 1) if (tickets[i].ownedPaths.some((a) => tickets[j].ownedPaths.some((b) => overlaps(a, b)))) throw new TypeError(`${tickets[i].id} and ${tickets[j].id} ownership overlaps.`);
  return Object.freeze(tickets);
}

export function validateRunInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("run input must be an object.");
  if (!ID.test(value.runId ?? "")) throw new TypeError("runId is invalid.");
  if (!SHA.test(value.baseSha ?? "")) throw new TypeError("baseSha is invalid.");
  if (typeof value.objective !== "string" || value.objective.length === 0 || value.objective.length > 16_000) throw new TypeError("objective is invalid.");
  if (!Number.isSafeInteger(value.maxConcurrency ?? 4) || (value.maxConcurrency ?? 4) < 1 || (value.maxConcurrency ?? 4) > 8) throw new TypeError("maxConcurrency is invalid.");
  return Object.freeze({ runId: value.runId, objective: value.objective, baseSha: value.baseSha, tickets: validateTicketGraph(value.tickets), maxConcurrency: value.maxConcurrency ?? 4, contextPaths: Object.freeze((value.contextPaths ?? []).map((item) => relative(item, "contextPath"))) });
}

export function readyTickets(tickets, states) {
  return tickets.filter((ticket) => (states[ticket.id]?.status ?? "pending") === "pending" && ticket.dependencies.every((dependency) => states[dependency]?.status === "done") && (!ticket.requiresIntegratedBase || ticket.dependencies.every((dependency) => states[dependency]?.integrated === true))).map((ticket) => ticket.id);
}

export function blockedByIntegration(tickets, states) {
  return tickets.some((ticket) => (states[ticket.id]?.status ?? "pending") === "pending" && ticket.dependencies.every((dependency) => states[dependency]?.status === "done") && ticket.requiresIntegratedBase && ticket.dependencies.some((dependency) => states[dependency]?.integrated !== true));
}

export function parsePorcelainV1Z(value) {
  const fields = Buffer.isBuffer(value) ? value.toString("utf8").split("\0") : String(value).split("\0"); const changed = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index]; if (!entry) continue; if (entry.length < 4 || entry[2] !== " ") throw new Error("git status output is malformed.");
    const status = entry.slice(0, 2); changed.push(relative(entry.slice(3), "changed path"));
    if (/[RC]/.test(status)) { const source = fields[++index]; if (!source) throw new Error("git rename/copy source is missing."); changed.push(relative(source, "changed source path")); }
  }
  return Object.freeze([...new Set(changed)].sort());
}

export function validateTicketResult(value, ticketId) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["version", "ticketId", "status", "summary", "changedPaths", "validation", "handoff", "question"].includes(key))) throw new TypeError("agent result is invalid.");
  if (value.version !== 1 || value.ticketId !== ticketId || !["done", "blocked", "failed"].includes(value.status)) throw new TypeError("agent result identity or status is invalid.");
  text(value.summary, "agent result summary"); text(value.handoff, "agent result handoff", 8000);
  if (!Array.isArray(value.changedPaths) || value.changedPaths.length > 128) throw new TypeError("agent result changedPaths is invalid.");
  const changedPaths = Object.freeze(value.changedPaths.map((item) => relative(item, "agent result changedPath")));
  if (!["passed", "failed", "not_run"].includes(value.validation)) throw new TypeError("agent result validation is invalid.");
  if (value.question !== null && (typeof value.question !== "string" || value.question.length === 0 || value.question.length > 4000)) throw new TypeError("agent result question is invalid.");
  return Object.freeze({ version: 1, ticketId, status: value.status, summary: value.summary, changedPaths, validation: value.validation, handoff: value.handoff, question: value.question });
}

export function buildContextPacket({ run, ticket, repositoryPath, worktreePath, promptPath, resultPath, nonce, dependencyHandoffs = [], guidance = "" }) {
  const lines = [
    `# Delivery ticket ${ticket.id}`,
    "", "## Run objective", run.objective,
    "", "## Goal", ticket.goal,
    "", "## Definition of done", ticket.definitionOfDone,
    "", "## Paths", `- Repository: \`${repositoryPath}\``, `- Assigned worktree: \`${worktreePath}\``, `- Context packet: \`${promptPath}\``, `- Result file: \`${resultPath}\``, `- Immutable base: \`${run.baseSha}\``,
    "", "## Ownership", ...ticket.ownedPaths.map((item) => `- \`${item}\``), `- Forbidden: ${ticket.forbiddenScope}`,
    "", "## Dependencies", ...(ticket.dependencies.length ? ticket.dependencies.map((item) => `- ${item}`) : ["- None"]),
    "", "## Dependency handoffs", ...(dependencyHandoffs.length ? dependencyHandoffs.map((item) => `- **${item.ticketId}:** ${item.handoff}`) : ["- None"]),
    "", "## Source documents", ...[...run.contextPaths, ...ticket.specPaths].map((item) => `- \`${item}\``),
    "", "## Validation", `- Executable: \`${ticket.validation.executable}\``, `- Args: ${JSON.stringify(ticket.validation.args)}`, `- Cwd: \`${ticket.validation.cwd ?? "."}\``,
    "", "## Agent contract", `- Model: \`${ticket.worker.model}\``, `- Thinking: \`${ticket.worker.thinking}\``, `- Tools: ${ticket.worker.tools.map((item) => `\`${item}\``).join(", ")}`,
    "", "## Parent guidance", guidance || "None.",
    "", "## Required result", `Call \`delivery_result_write\` once with nonce \`${nonce}\` and this schema:`, "```json", JSON.stringify({ nonce, ticketId: ticket.id, status: "done | blocked | failed", summary: "bounded summary", changedPaths: ["relative/path"], validation: "passed | failed | not_run", handoff: "short context for dependent agents", question: null }, null, 2), "```",
    "", "## Stop and escalation", "Stop and report blocked for scope changes, dependency additions, architecture/product decisions, unknown Herdr state, ambiguous prior action, destructive operations, publication, or work outside owned paths. Do not merge, clean up, push, publish, deploy, or replace another agent.",
  ];
  const packet = `${lines.join("\n")}\n`; if (Buffer.byteLength(packet) > 64 * 1024) throw new Error("context packet exceeds 64 KiB."); return packet;
}
