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
function boundedInteger(value, label, minimum, maximum, defaultValue) {
  const normalized = value === undefined ? defaultValue : value;
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  return normalized;
}
function stringArray(value, label) {
  if (!Array.isArray(value) || value.length > 32) throw new TypeError(`${label} must contain 0-32 strings.`);
  return Object.freeze(value.map((item, index) => text(item, `${label}[${index}]`, 4000)));
}
function command(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  const keys = Object.keys(value); if (keys.some((key) => !["executable", "args", "cwd"].includes(key))) throw new TypeError(`${label} has unknown properties.`);
  const executable = text(value.executable, `${label}.executable`, 1024);
  if (!Array.isArray(value.args) || value.args.length > 256 || value.args.some((arg) => typeof arg !== "string" || arg.length > 8192 || arg.includes("\0"))) throw new TypeError(`${label}.args is invalid.`);
  return Object.freeze({ executable, args: Object.freeze([...value.args]), ...(value.cwd ? { cwd: validationCwd(value.cwd, `${label}.cwd`) } : {}) });
}
function integrationValidation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("integrationValidation must be an object.");
  const keys = Object.keys(value); if (keys.some((key) => !["executable", "args", "cwd", "timeoutSeconds"].includes(key))) throw new TypeError("integrationValidation has unknown properties.");
  const normalized = command({ executable: value.executable, args: value.args, ...(value.cwd !== undefined ? { cwd: value.cwd } : {}) }, "integrationValidation");
  return Object.freeze({ ...normalized, timeoutSeconds: boundedInteger(value.timeoutSeconds, "integrationValidation.timeoutSeconds", 30, 1800) });
}
function ticketContext(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  const fields = ["observableBehavior", "acceptanceExamples", "nonGoals", "entryPoints", "invariants", "expectedValidation", "unresolvedDecisions"];
  if (Object.keys(value).some((key) => !fields.includes(key))) throw new TypeError(`${label} has unknown properties.`);
  return Object.freeze(Object.fromEntries(fields.filter((field) => value[field] !== undefined).map((field) => [field, stringArray(value[field], `${label}.${field}`)])));
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
    const allowed = new Set(["id", "goal", "definitionOfDone", "dependencies", "ownedPaths", "forbiddenScope", "worker", "validation", "requiresIntegratedBase", "specPaths", "maxFixRounds", "timeoutSeconds", "validationTimeoutSeconds", "context", "mode", "readPaths"]);
    if (Object.keys(raw).some((key) => !allowed.has(key))) throw new TypeError(`${raw.id ?? `tickets[${index}]`} has unknown properties.`);
    const ticketId = id(raw.id, `tickets[${index}].id`); if (seen.has(ticketId)) throw new TypeError(`duplicate ticket ${ticketId}.`); seen.add(ticketId);
    if (!Array.isArray(raw.dependencies) || raw.dependencies.length > 32) throw new TypeError(`${ticketId}.dependencies is invalid.`);
    const mode = raw.mode ?? "implementation";
    if (!["implementation", "review"].includes(mode)) throw new TypeError(`${ticketId}.mode must be implementation or review.`);
    if (!Array.isArray(raw.ownedPaths) || raw.ownedPaths.length > 64 || (mode === "implementation" && raw.ownedPaths.length === 0) || (mode === "review" && raw.ownedPaths.length !== 0)) throw new TypeError(`${ticketId}.ownedPaths is invalid for ${mode} mode.`);
    if (mode === "review" ? !Array.isArray(raw.readPaths) || raw.readPaths.length === 0 || raw.readPaths.length > 64 : raw.readPaths !== undefined) throw new TypeError(`${ticketId}.readPaths is invalid for ${mode} mode.`);
    const worker = raw.worker;
    if (!worker || typeof worker !== "object" || Array.isArray(worker) || Object.keys(worker).some((key) => !["name", "kind", "model", "thinking", "tools"].includes(key))) throw new TypeError(`${ticketId}.worker is invalid.`);
    if (!Array.isArray(worker.tools) || worker.tools.length === 0 || worker.tools.length > 32 || (mode === "review" && (worker.tools.length !== 1 || worker.tools[0] !== "read"))) throw new TypeError(`${ticketId}.worker.tools is invalid for ${mode} mode.`);
    const maxFixRounds = boundedInteger(raw.maxFixRounds, `${ticketId}.maxFixRounds`, 0, 1, 0);
    if (mode === "review" && maxFixRounds !== 0) throw new TypeError(`${ticketId}.maxFixRounds must be zero in review mode.`);
    const normalized = {
      id: ticketId,
      mode,
      goal: text(raw.goal, `${ticketId}.goal`),
      definitionOfDone: text(raw.definitionOfDone, `${ticketId}.definitionOfDone`),
      dependencies: Object.freeze(raw.dependencies.map((item) => id(item, `${ticketId}.dependency`))),
      ownedPaths: Object.freeze(raw.ownedPaths.map((item) => relative(item, `${ticketId}.ownedPath`, item.endsWith("/")))),
      ...(mode === "review" ? { readPaths: Object.freeze(raw.readPaths.map((item) => relative(item, `${ticketId}.readPath`, item.endsWith("/")))) } : {}),
      forbiddenScope: text(raw.forbiddenScope ?? "Everything outside owned paths.", `${ticketId}.forbiddenScope`),
      worker: Object.freeze({ name: agentName(worker.name, `${ticketId}.worker.name`), kind: workerKind(worker.kind, `${ticketId}.worker.kind`), model: text(worker.model, `${ticketId}.worker.model`, 256), thinking: text(worker.thinking, `${ticketId}.worker.thinking`, 32), tools: Object.freeze(worker.tools.map((item) => id(item, `${ticketId}.worker.tool`))) }),
      validation: command(raw.validation, `${ticketId}.validation`),
      requiresIntegratedBase: raw.requiresIntegratedBase !== false,
      specPaths: Object.freeze((raw.specPaths ?? []).map((item) => relative(item, `${ticketId}.specPath`))),
      maxFixRounds,
      timeoutSeconds: boundedInteger(raw.timeoutSeconds, `${ticketId}.timeoutSeconds`, 60, 7200, 300),
      validationTimeoutSeconds: boundedInteger(raw.validationTimeoutSeconds, `${ticketId}.validationTimeoutSeconds`, 30, 1800, 300),
      ...(raw.context === undefined ? {} : { context: ticketContext(raw.context, `${ticketId}.context`) }),
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
  return Object.freeze({ runId: value.runId, objective: value.objective, baseSha: value.baseSha, tickets: validateTicketGraph(value.tickets), maxConcurrency: value.maxConcurrency ?? 4, contextPaths: Object.freeze((value.contextPaths ?? []).map((item) => relative(item, "contextPath"))), ...(value.integrationValidation === undefined ? {} : { integrationValidation: integrationValidation(value.integrationValidation) }) });
}

function approvedReview(state) { return ["disposed", "cleaned"].includes(state?.status) && state.disposition === "approve"; }
function validated(state) { return ["validation_passed", "integrated"].includes(state?.status) || (state?.status === "cleaned" && state.disposition === undefined) || approvedReview(state); }
function integrated(state) { return state?.status === "integrated" || (state?.status === "cleaned" && state.disposition === undefined) || approvedReview(state); }

export function readyTickets(tickets, states) {
  return tickets.filter((ticket) => (states[ticket.id]?.status ?? "pending") === "pending" && ticket.dependencies.every((dependency) => validated(states[dependency])) && (!ticket.requiresIntegratedBase || ticket.dependencies.every((dependency) => integrated(states[dependency])))).map((ticket) => ticket.id);
}

export function blockedByIntegration(tickets, states) {
  return tickets.some((ticket) => (states[ticket.id]?.status ?? "pending") === "pending" && ticket.dependencies.every((dependency) => validated(states[dependency])) && ticket.requiresIntegratedBase && ticket.dependencies.some((dependency) => !integrated(states[dependency])));
}

const PREFLIGHT_STOP_CONDITIONS = Object.freeze([
  "ownership/dependency/product/API/architecture change",
  "dirty required parent base",
  "unsupported runtime field/tool",
  "failed parent barrier",
  "exhausted fix/remediation",
  "unknown Herdr state",
  "missing/malformed result",
  "deadline",
  "unexpected HEAD",
  "dependency install",
  "destructive action",
  "reload during active phase",
  "replay/replacement/merge/cleanup/publication required",
]);

export function preflightWarnings(run) {
  const warnings = [];
  for (const ticket of [...run.tickets].sort((a, b) => a.id.localeCompare(b.id))) {
    if (ticket.validation.args.length === 0 || (ticket.validation.executable === "node" && ticket.validation.args.length === 1 && ticket.validation.args[0] === "--test")) warnings.push(Object.freeze({ code: "weak_validation", ticketId: ticket.id, message: "Validation does not name a focused target." }));
    if (ticket.ownedPaths.some((item) => item.endsWith("/"))) warnings.push(Object.freeze({ code: "broad_ownership", ticketId: ticket.id, message: "Directory ownership grants a broad write scope." }));
    if (!ticket.context || !ticket.context.observableBehavior?.length || !ticket.context.acceptanceExamples?.length || !ticket.context.invariants?.length) warnings.push(Object.freeze({ code: "thin_context", ticketId: ticket.id, message: "Context omits observable behavior, acceptance examples, or invariants." }));
  }
  return Object.freeze(warnings);
}

export function unweightedCriticalPath(tickets) {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const memo = new Map();
  const pathTo = (ticketId) => {
    if (memo.has(ticketId)) return memo.get(ticketId);
    const dependencies = [...byId.get(ticketId).dependencies].sort();
    const candidates = dependencies.map(pathTo);
    const prefix = candidates.sort((a, b) => b.length - a.length || a.join("\0").localeCompare(b.join("\0")))[0] ?? [];
    const result = Object.freeze([...prefix, ticketId]); memo.set(ticketId, result); return result;
  };
  const candidates = [...byId.keys()].sort().map(pathTo);
  const ticketIds = candidates.sort((a, b) => b.length - a.length || a.join("\0").localeCompare(b.join("\0")))[0] ?? Object.freeze([]);
  return Object.freeze({ ticketIds, length: ticketIds.length });
}

export function previewTicketGraph(run) {
  const tickets = [...run.tickets].sort((a, b) => a.id.localeCompare(b.id));
  const nodes = tickets.map((ticket) => Object.freeze({
    id: ticket.id,
    mode: ticket.mode,
    dependencies: Object.freeze([...ticket.dependencies].sort()),
    ownedPaths: Object.freeze([...ticket.ownedPaths]),
    ...(ticket.mode === "review" ? { readPaths: Object.freeze([...ticket.readPaths]) } : {}),
    requiresIntegratedBase: ticket.requiresIntegratedBase,
    validation: Object.freeze({ executable: ticket.validation.executable, args: Object.freeze([...ticket.validation.args]), cwd: ticket.validation.cwd ?? ".", timeoutSeconds: ticket.validationTimeoutSeconds }),
    worker: Object.freeze({ model: ticket.worker.model, thinking: ticket.worker.thinking, tools: Object.freeze([...ticket.worker.tools]) }),
    maxFixRounds: ticket.maxFixRounds,
    timeoutSeconds: ticket.timeoutSeconds,
  }));
  const edges = tickets.flatMap((ticket) => [...ticket.dependencies].sort().map((dependency) => Object.freeze({ from: dependency, to: ticket.id })));
  const initialSlots = run.tickets.filter((ticket) => ticket.dependencies.length === 0).slice(0, run.maxConcurrency).map((ticket) => ticket.id);
  const integrationGates = tickets.filter((ticket) => ticket.requiresIntegratedBase && ticket.dependencies.length).map((ticket) => Object.freeze({ ticketId: ticket.id, after: Object.freeze([...ticket.dependencies].sort()) }));
  const reviewGates = tickets.filter((ticket) => ticket.mode === "review").map((ticket) => Object.freeze({ ticketId: ticket.id, dispositionRequired: "approve", dependenciesProceedOnlyAfterApproval: true }));
  return Object.freeze({
    version: 1,
    runId: run.runId,
    graph: Object.freeze({ nodes: Object.freeze(nodes), edges: Object.freeze(edges) }),
    initialSlots: Object.freeze(initialSlots),
    gates: Object.freeze({
      integrationValidation: run.integrationValidation ? Object.freeze({ executable: run.integrationValidation.executable, args: Object.freeze([...run.integrationValidation.args]), cwd: run.integrationValidation.cwd ?? ".", timeoutSeconds: run.integrationValidation.timeoutSeconds }) : null,
      integratedBase: Object.freeze(integrationGates),
      reviewDisposition: Object.freeze(reviewGates),
    }),
    warnings: preflightWarnings(run),
    criticalPath: unweightedCriticalPath(tickets),
    stopConditions: PREFLIGHT_STOP_CONDITIONS,
  });
}

export function renderTicketGraphMarkdown(run) {
  const preview = previewTicketGraph(run); const lines = [`# Delivery preview: ${preview.runId}`, "", "## Graph"];
  for (const node of preview.graph.nodes) lines.push(`- **${node.id}** (${node.mode}) <- ${node.dependencies.length ? node.dependencies.join(", ") : "root"}`);
  lines.push("", "## Initial slots", ...(preview.initialSlots.length ? preview.initialSlots.map((id) => `- ${id}`) : ["- None"]), "", "## Gates");
  lines.push(`- Integration validation: ${preview.gates.integrationValidation ? `\`${preview.gates.integrationValidation.executable}\` ${JSON.stringify(preview.gates.integrationValidation.args)}` : "None"}`);
  for (const gate of preview.gates.integratedBase) lines.push(`- ${gate.ticketId}: integrated base after ${gate.after.join(", ")}`);
  for (const gate of preview.gates.reviewDisposition) lines.push(`- ${gate.ticketId}: parent disposition \`${gate.dispositionRequired}\` required before dependencies proceed`);
  lines.push("", "## Tickets");
  for (const node of preview.graph.nodes) {
    lines.push(`### ${node.id}`, `- Ownership: ${node.ownedPaths.length ? node.ownedPaths.map((item) => `\`${item}\``).join(", ") : "None"}`);
    if (node.readPaths) lines.push(`- Read paths: ${node.readPaths.map((item) => `\`${item}\``).join(", ")}`);
    lines.push(`- Validation argv: \`${node.validation.executable}\` ${JSON.stringify(node.validation.args)}`, `- Model: \`${node.worker.model}\`; thinking: \`${node.worker.thinking}\`; tools: ${node.worker.tools.map((item) => `\`${item}\``).join(", ")}`, `- Fix limit: ${node.maxFixRounds}; ticket timeout: ${node.timeoutSeconds}s; validation timeout: ${node.validation.timeoutSeconds}s`);
  }
  lines.push("", "## Critical path", `- ${preview.criticalPath.ticketIds.join(" -> ")} (${preview.criticalPath.length} tickets)`, "", "## Warnings", ...(preview.warnings.length ? preview.warnings.map((warning) => `- [${warning.code}] ${warning.ticketId}: ${warning.message}`) : ["- None"]), "", "## Stop conditions", ...preview.stopConditions.map((item) => `- ${item}`));
  return `${lines.join("\n")}\n`;
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

export function validateTicketResult(value, ticketId, mode = "implementation") {
  if (mode === "review") {
    const keys = ["version", "ticketId", "verdict", "summary", "findings", "residualRisks", "question"];
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) throw new TypeError("review result is invalid.");
    if (value.version !== 1 || value.ticketId !== ticketId || !["approve", "changes_requested", "blocked"].includes(value.verdict)) throw new TypeError("review result identity or verdict is invalid.");
    text(value.summary, "review result summary");
    if (!Array.isArray(value.findings) || value.findings.length > 128) throw new TypeError("review result findings is invalid.");
    const findings = Object.freeze(value.findings.map((finding, index) => {
      const label = `review result findings[${index}]`;
      if (!finding || typeof finding !== "object" || Array.isArray(finding) || Object.keys(finding).length !== 4 || Object.keys(finding).some((key) => !["severity", "affectedPath", "evidence", "disposition"].includes(key))) throw new TypeError(`${label} is invalid.`);
      if (!["critical", "high", "medium", "low"].includes(finding.severity) || finding.disposition !== "open") throw new TypeError(`${label} severity or disposition is invalid.`);
      return Object.freeze({ severity: finding.severity, affectedPath: relative(finding.affectedPath, `${label}.affectedPath`, finding.affectedPath?.endsWith("/")), evidence: text(finding.evidence, `${label}.evidence`, 8000), disposition: "open" });
    }));
    const residualRisks = stringArray(value.residualRisks, "review result residualRisks");
    if (value.question !== null) text(value.question, "review result question", 4000);
    const result = { version: 1, ticketId, verdict: value.verdict, summary: value.summary, findings, residualRisks, question: value.question };
    if (Buffer.byteLength(`${JSON.stringify(result)}\n`) > 64 * 1024) throw new TypeError("review result exceeds 64 KiB.");
    return Object.freeze(result);
  }
  if (mode !== "implementation") throw new TypeError("agent result mode is invalid.");
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
  const contextSections = { observableBehavior: "Observable behavior", acceptanceExamples: "Acceptance examples", nonGoals: "Non-goals", entryPoints: "Entry points", invariants: "Invariants", expectedValidation: "Expected validation", unresolvedDecisions: "Unresolved decisions" };
  const richContext = Object.entries(contextSections).flatMap(([field, heading]) => ticket.context?.[field]?.length ? ["", `## ${heading}`, ...ticket.context[field].map((item) => `- ${item}`)] : []);
  const lines = [
    `# Delivery ticket ${ticket.id}`,
    "", "## Run objective", run.objective,
    "", "## Goal", ticket.goal,
    "", "## Definition of done", ticket.definitionOfDone,
    ...richContext,
    "", "## Paths", `- Repository: \`${repositoryPath}\``, `- Assigned worktree: \`${worktreePath}\``, `- Context packet: \`${promptPath}\``, `- Result file: \`${resultPath}\``, `- Immutable base: \`${run.baseSha}\``,
    "", ticket.mode === "review" ? "## Read scope" : "## Ownership", ...(ticket.mode === "review" ? ticket.readPaths : ticket.ownedPaths).map((item) => `- \`${item}\``), `- Forbidden: ${ticket.forbiddenScope}`,
    "", "## Dependencies", ...(ticket.dependencies.length ? ticket.dependencies.map((item) => `- ${item}`) : ["- None"]),
    "", "## Dependency handoffs", ...(dependencyHandoffs.length ? dependencyHandoffs.map((item) => `- **${item.ticketId}:** ${item.handoff}`) : ["- None"]),
    "", "## Source documents", ...[...run.contextPaths, ...ticket.specPaths].map((item) => `- \`${item}\``),
    "", "## Validation", ...(ticket.mode === "review" ? ["- Parent-run only; reviewer must not execute validation."] : []), `- Executable: \`${ticket.validation.executable}\``, `- Args: ${JSON.stringify(ticket.validation.args)}`, `- Cwd: \`${ticket.validation.cwd ?? "."}\``,
    ...(run.integrationValidation ? ["", "## Integration validation", `- Executable: \`${run.integrationValidation.executable}\``, `- Args: ${JSON.stringify(run.integrationValidation.args)}`, `- Cwd: \`${run.integrationValidation.cwd ?? "."}\``, `- Timeout seconds: ${run.integrationValidation.timeoutSeconds}`] : []),
    "", "## Agent contract", `- Model: \`${ticket.worker.model}\``, `- Thinking: \`${ticket.worker.thinking}\``, `- Tools: ${ticket.worker.tools.map((item) => `\`${item}\``).join(", ")}`,
    "", "## Parent guidance", guidance || "None.",
    "", "## Required result", `Call \`delivery_result_write\` once with nonce \`${nonce}\` and this schema:`, "```json", JSON.stringify(ticket.mode === "review" ? { nonce, ticketId: ticket.id, verdict: "approve | changes_requested | blocked", summary: "bounded summary", findings: [{ severity: "critical | high | medium | low", affectedPath: "relative/path", evidence: "bounded evidence", disposition: "open" }], residualRisks: ["bounded risk"], question: null } : { nonce, ticketId: ticket.id, status: "done | blocked | failed", summary: "bounded summary", changedPaths: ["relative/path"], validation: "passed | failed | not_run", handoff: "short context for dependent agents", question: null }, null, 2), "```",
    "", "## Stop and escalation", "Stop and report blocked for scope changes, dependency additions, architecture/product decisions, unknown Herdr state, ambiguous prior action, destructive operations, publication, or work outside owned paths. Do not merge, clean up, push, publish, deploy, or replace another agent.",
  ];
  const packet = `${lines.join("\n")}\n`; if (Buffer.byteLength(packet) > 64 * 1024) throw new Error("context packet exceeds 64 KiB."); return packet;
}
