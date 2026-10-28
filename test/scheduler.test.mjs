import assert from "node:assert/strict";
import test from "node:test";
import { blockedByIntegration, buildContextPacket, parsePorcelainV1Z, readyTickets, validateRunInput, validateTicketResult } from "../extensions/lib/scheduler.mjs";

function input() { return { runId: "run-1", objective: "Ship visible workflow", baseSha: "a".repeat(40), maxConcurrency: 2, contextPaths: [".scratch/spec.md"], tickets: [
  { id: "T1", goal: "First", definitionOfDone: "first done", dependencies: [], ownedPaths: ["src/a.js"], worker: { name: "worker-a", kind: "pi", model: "model-a", thinking: "medium", tools: ["read", "write"] }, validation: { executable: "node", args: ["--test"] } },
  { id: "T2", goal: "Second", definitionOfDone: "second done", dependencies: [], ownedPaths: ["src/b.js"], worker: { name: "worker-b", kind: "pi", model: "model-b", thinking: "medium", tools: ["read", "write"] }, validation: { executable: "node", args: ["--test"] } },
  { id: "T3", goal: "Dependent", definitionOfDone: "third done", dependencies: ["T1", "T2"], ownedPaths: ["src/c.js"], worker: { name: "worker-c", kind: "pi", model: "model-c", thinking: "medium", tools: ["read", "write"] }, validation: { executable: "node", args: ["--test"] }, requiresIntegratedBase: true },
] }; }

test("validates graph, ownership, cycles, and readiness", () => {
  const value = input(); value.tickets[0].validation.cwd = "."; value.tickets[0].worker.kind = "worker"; value.tickets[1].worker.kind = "reviewer";
  const run = validateRunInput(value);
  assert.equal(run.tickets[0].validation.cwd, ".");
  assert.equal(run.tickets[0].worker.kind, "pi"); assert.equal(run.tickets[1].worker.kind, "pi");
  const states = { T1: { status: "pending" }, T2: { status: "pending" }, T3: { status: "pending" } };
  assert.deepEqual(readyTickets(run.tickets, states), ["T1", "T2"]);
  states.T1 = { status: "validation_passed" }; states.T2 = { status: "validation_passed" };
  assert.deepEqual(readyTickets(run.tickets, states), []); assert.equal(blockedByIntegration(run.tickets, states), true);
  states.T1.status = "integrated"; states.T2.status = "integrated"; assert.deepEqual(readyTickets(run.tickets, states), ["T3"]);
  const overlap = input(); overlap.tickets[1].ownedPaths = ["src/"]; assert.throws(() => validateRunInput(overlap), /overlaps/);
  const cycle = input(); cycle.tickets[0].dependencies = ["T3"]; assert.throws(() => validateRunInput(cycle), /cycle/);
  const unsupported = input(); unsupported.tickets[0].worker.kind = "codex"; assert.throws(() => validateRunInput(unsupported), /must be pi, worker, or reviewer/);
});

test("normalizes strict implementation and review modes", () => {
  assert.equal(validateRunInput(input()).tickets[0].mode, "implementation");
  const value = input(); const review = value.tickets[0]; value.tickets = [review];
  Object.assign(review, { mode: "review", ownedPaths: [], readPaths: ["src/", "README.md"], maxFixRounds: 0 }); review.worker.tools = ["read"];
  const ticket = validateRunInput(value).tickets[0];
  assert.equal(ticket.mode, "review"); assert.deepEqual(ticket.readPaths, ["src/", "README.md"]); assert.deepEqual(ticket.ownedPaths, []);
  for (const mutate of [
    (item) => { item.readPaths = undefined; },
    (item) => { item.readPaths = ["../escape"]; },
    (item) => { item.ownedPaths = ["src/a.js"]; },
    (item) => { item.worker.tools = ["read", "write"]; },
    (item) => { item.maxFixRounds = 1; },
  ]) { const invalid = structuredClone(value); mutate(invalid.tickets[0]); assert.throws(() => validateRunInput(invalid)); }
  const implementation = input(); implementation.tickets[0].readPaths = ["src/"]; assert.throws(() => validateRunInput(implementation), /readPaths/);
});

test("normalizes bounded execution controls", () => {
  const defaults = validateRunInput(input()).tickets[0];
  assert.equal(defaults.maxFixRounds, 0);
  assert.equal(defaults.timeoutSeconds, 300);
  assert.equal(defaults.validationTimeoutSeconds, 300);

  const value = input();
  Object.assign(value.tickets[0], { maxFixRounds: 1, timeoutSeconds: 7200, validationTimeoutSeconds: 1800 });
  const configured = validateRunInput(value).tickets[0];
  assert.equal(configured.maxFixRounds, 1);
  assert.equal(configured.timeoutSeconds, 7200);
  assert.equal(configured.validationTimeoutSeconds, 1800);
});

test("normalizes optional integration validation without rewriting tickets", () => {
  const value = input();
  value.integrationValidation = { executable: "npm", args: ["run", "check"], cwd: ".", timeoutSeconds: 1800 };
  const originalTickets = structuredClone(value.tickets);
  const run = validateRunInput(value);
  assert.deepEqual(run.integrationValidation, { executable: "npm", args: ["run", "check"], cwd: ".", timeoutSeconds: 1800 });
  assert.deepEqual(value.tickets, originalTickets);
  assert.equal(run.tickets[0].integrationValidation, undefined);

  for (const timeoutSeconds of [undefined, 29, 1801, 30.5]) {
    const invalid = input(); invalid.integrationValidation = { executable: "node", args: [], timeoutSeconds };
    assert.throws(() => validateRunInput(invalid), /integrationValidation\.timeoutSeconds/);
  }
  const shell = input(); shell.integrationValidation = { executable: "node", args: [], timeoutSeconds: 30, shell: true };
  assert.throws(() => validateRunInput(shell), /unknown properties/);
});

test("parses porcelain v1 NUL renames with source and destination", () => {
  assert.deepEqual(parsePorcelainV1Z(`R  new.js\0old.js\0?? untracked.js\0`), ["new.js", "old.js", "untracked.js"]);
  assert.throws(() => parsePorcelainV1Z("R  new.js\0"), /source/);
});

test("ticket result schema is exact and bounded", () => {
  assert.equal(validateTicketResult({ version: 1, ticketId: "T1", status: "done", summary: "ok", changedPaths: ["src/a.js"], validation: "passed", handoff: "exports A", question: null }, "T1").status, "done");
  assert.throws(() => validateTicketResult({ version: 1, ticketId: "T2", status: "done", summary: "ok", changedPaths: [], validation: "passed", handoff: "x", question: null }, "T1"), /identity/);
  assert.throws(() => validateTicketResult({ version: 1, ticketId: "T1", status: "done", summary: "ok", changedPaths: ["../escape"], validation: "passed", handoff: "x", question: null }, "T1"), /relative/);
});

test("review result schema is exact, bounded, and path-safe", () => {
  const value = { version: 1, ticketId: "R1", verdict: "changes_requested", summary: "fix finding", findings: [{ severity: "high", affectedPath: "src/a.js", evidence: "unsafe edge", disposition: "open" }], residualRisks: ["parent validation pending"], question: null };
  assert.deepEqual(validateTicketResult(value, "R1", "review"), value);
  for (const mutate of [
    (result) => { result.verdict = "done"; },
    (result) => { result.findings[0].affectedPath = "../escape"; },
    (result) => { result.findings[0].disposition = "fixed"; },
    (result) => { result.extra = true; },
  ]) { const invalid = structuredClone(value); mutate(invalid); assert.throws(() => validateTicketResult(invalid, "R1", "review")); }
  const oversized = structuredClone(value); oversized.findings = Array.from({ length: 9 }, (_, index) => ({ severity: "low", affectedPath: `src/${index}.js`, evidence: "x".repeat(8000), disposition: "open" })); assert.throws(() => validateTicketResult(oversized, "R1", "review"), /64 KiB/);
});

test("context packet contains bounded ticket context and dependency handoffs", () => {
  const run = validateRunInput(input()); const ticket = run.tickets[2];
  const packet = buildContextPacket({ run, ticket, repositoryPath: "/repo", worktreePath: "/work/T3", promptPath: "/repo/.scratch/run/prompts/T3.md", resultPath: "/repo/.scratch/run/results/T3.json", nonce: "nonce", dependencyHandoffs: [{ ticketId: "T1", handoff: "exports A" }, { ticketId: "T2", handoff: "exports B" }] });
  assert.match(packet, /Ship visible workflow/); assert.match(packet, /exports A/); assert.match(packet, /exports B/); assert.match(packet, /src\/c\.js/); assert.match(packet, /delivery_result_write/); assert.doesNotMatch(packet, /unrelated transcript/);

  const value = input(); value.tickets = [value.tickets[0]]; Object.assign(value.tickets[0], { mode: "review", ownedPaths: [], readPaths: ["src/"] }); value.tickets[0].worker.tools = ["read"];
  const reviewRun = validateRunInput(value); const reviewPacket = buildContextPacket({ run: reviewRun, ticket: reviewRun.tickets[0], repositoryPath: "/repo", worktreePath: "/work/R1", promptPath: "/prompt", resultPath: "/result", nonce: "nonce" });
  assert.match(reviewPacket, /## Read scope/); assert.match(reviewPacket, /Parent-run only/); assert.match(reviewPacket, /changes_requested/); assert.doesNotMatch(reviewPacket, /changedPaths/);
});
