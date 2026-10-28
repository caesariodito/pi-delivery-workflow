import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { validateRunInput, validateTicketResult } from "../extensions/lib/scheduler.mjs";

function reviewTicket() {
  return { runId: "review-run", objective: "Review", baseSha: "a".repeat(40), tickets: [{ id: "R1", mode: "review", goal: "Review change", definitionOfDone: "Verdict recorded", dependencies: [], ownedPaths: [], readPaths: ["extensions/", "test/a.mjs"], worker: { name: "reviewer", kind: "reviewer", model: "model", thinking: "medium", tools: ["read"] }, validation: { executable: "npm", args: ["run", "check"] }, maxFixRounds: 0 }] };
}

test("review contract stays read-only and parent-validated", () => {
  const ticket = validateRunInput(reviewTicket()).tickets[0];
  assert.deepEqual(ticket.worker.tools, ["read"]); assert.deepEqual(ticket.ownedPaths, []); assert.deepEqual(ticket.readPaths, ["extensions/", "test/a.mjs"]); assert.equal(ticket.validation.executable, "npm");
});

test("review result has bounded structured verdict and findings", () => {
  const result = validateTicketResult({ version: 1, ticketId: "R1", verdict: "approve", summary: "No findings", findings: [], residualRisks: [], question: null }, "R1", "review");
  assert.deepEqual(Object.keys(result), ["version", "ticketId", "verdict", "summary", "findings", "residualRisks", "question"]);
});

test("result tool source binds mode and preserves implementation byte shape", () => {
  const source = fs.readFileSync(new URL("../extensions/reviewer-result-tool.ts", import.meta.url), "utf8");
  assert.match(source, /registerFlag\("delivery-result-mode"/); assert.match(source, /mode === "review"/); assert.match(source, /delivery result exceeds 64 KiB/); assert.match(source, /O_EXCL/);
  assert.match(source, /validateTicketResult\(\{ version: 1, \.\.\.ticketResult \}, input\.ticketId, mode\)/); assert.match(source, /JSON\.stringify\(validated\)/);
});
