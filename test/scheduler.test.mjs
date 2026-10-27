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

test("parses porcelain v1 NUL renames with source and destination", () => {
  assert.deepEqual(parsePorcelainV1Z(`R  new.js\0old.js\0?? untracked.js\0`), ["new.js", "old.js", "untracked.js"]);
  assert.throws(() => parsePorcelainV1Z("R  new.js\0"), /source/);
});

test("ticket result schema is exact and bounded", () => {
  assert.equal(validateTicketResult({ version: 1, ticketId: "T1", status: "done", summary: "ok", changedPaths: ["src/a.js"], validation: "passed", handoff: "exports A", question: null }, "T1").status, "done");
  assert.throws(() => validateTicketResult({ version: 1, ticketId: "T2", status: "done", summary: "ok", changedPaths: [], validation: "passed", handoff: "x", question: null }, "T1"), /identity/);
  assert.throws(() => validateTicketResult({ version: 1, ticketId: "T1", status: "done", summary: "ok", changedPaths: ["../escape"], validation: "passed", handoff: "x", question: null }, "T1"), /relative/);
});

test("context packet contains bounded ticket context and dependency handoffs", () => {
  const run = validateRunInput(input()); const ticket = run.tickets[2];
  const packet = buildContextPacket({ run, ticket, repositoryPath: "/repo", worktreePath: "/work/T3", promptPath: "/repo/.scratch/run/prompts/T3.md", resultPath: "/repo/.scratch/run/results/T3.json", nonce: "nonce", dependencyHandoffs: [{ ticketId: "T1", handoff: "exports A" }, { ticketId: "T2", handoff: "exports B" }] });
  assert.match(packet, /Ship visible workflow/); assert.match(packet, /exports A/); assert.match(packet, /exports B/); assert.match(packet, /src\/c\.js/); assert.match(packet, /delivery_result_write/); assert.doesNotMatch(packet, /unrelated transcript/);
});
