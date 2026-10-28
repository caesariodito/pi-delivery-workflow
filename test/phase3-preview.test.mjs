import assert from "node:assert/strict";
import test from "node:test";
import { preflightWarnings, previewTicketGraph, renderTicketGraphMarkdown, unweightedCriticalPath, validateRunInput } from "../extensions/lib/scheduler.mjs";

function input() {
  return {
    runId: "preview-run",
    objective: "Preview work",
    baseSha: "a".repeat(40),
    maxConcurrency: 2,
    integrationValidation: { executable: "npm", args: ["run", "check"], cwd: ".", timeoutSeconds: 600 },
    tickets: [
      { id: "C", mode: "review", goal: "Review", definitionOfDone: "Review done", dependencies: ["B"], ownedPaths: [], readPaths: ["src/"], worker: { name: "review-c", kind: "reviewer", model: "review-model", thinking: "medium", tools: ["read"] }, validation: { executable: "node", args: ["--test", "test/c.test.mjs"] }, requiresIntegratedBase: true },
      { id: "A", goal: "Root A", definitionOfDone: "A done", dependencies: [], ownedPaths: ["root-a/"], worker: { name: "worker-a", kind: "worker", model: "model-a", thinking: "medium", tools: ["read", "write"] }, validation: { executable: "node", args: ["--test"] }, context: { observableBehavior: ["A visible"], acceptanceExamples: ["A passes"], invariants: ["A safe"] } },
      { id: "D", goal: "Root D", definitionOfDone: "D done", dependencies: [], ownedPaths: ["docs/d.md"], worker: { name: "worker-d", kind: "worker", model: "model-d", thinking: "low", tools: ["read", "write"] }, validation: { executable: "node", args: ["--test", "test/d.test.mjs"] }, context: { observableBehavior: ["D visible"] } },
      { id: "B", goal: "Middle", definitionOfDone: "B done", dependencies: ["A"], ownedPaths: ["src/b.js"], worker: { name: "worker-b", kind: "worker", model: "model-b", thinking: "medium", tools: ["read", "write"] }, validation: { executable: "node", args: ["--test", "test/b.test.mjs"] }, maxFixRounds: 1, timeoutSeconds: 900, validationTimeoutSeconds: 120, context: { observableBehavior: ["B visible"], acceptanceExamples: ["B passes"], invariants: ["B safe"] } },
    ],
  };
}

test("preflight warns without rewriting normalized or source input", () => {
  const source = input(); const before = structuredClone(source); const run = validateRunInput(source); const normalizedBefore = structuredClone(run);
  assert.deepEqual(preflightWarnings(run).map(({ code, ticketId }) => [code, ticketId]), [
    ["weak_validation", "A"], ["broad_ownership", "A"], ["thin_context", "C"], ["thin_context", "D"],
  ]);
  assert.deepEqual(source, before); assert.deepEqual(run, normalizedBefore);
});

test("preview is stable and exposes graph, slots, gates, scopes, commands, workers, limits, and unweighted critical path", () => {
  const run = validateRunInput(input()); const preview = previewTicketGraph(run);
  assert.deepEqual(preview.graph.nodes.map(({ id }) => id), ["A", "B", "C", "D"]);
  assert.deepEqual(preview.graph.edges, [{ from: "A", to: "B" }, { from: "B", to: "C" }]);
  assert.deepEqual(preview.initialSlots, ["A", "D"]);
  assert.deepEqual(preview.gates.integratedBase, [{ ticketId: "B", after: ["A"] }, { ticketId: "C", after: ["B"] }]);
  assert.deepEqual(preview.gates.reviewDisposition, [{ ticketId: "C", dispositionRequired: "approve", dependenciesProceedOnlyAfterApproval: true }]);
  assert.deepEqual(preview.gates.integrationValidation.args, ["run", "check"]);
  assert.deepEqual(preview.criticalPath, { ticketIds: ["A", "B", "C"], length: 3 });
  assert.deepEqual(unweightedCriticalPath(run.tickets), preview.criticalPath);
  assert.deepEqual(preview.graph.nodes[1].validation, { executable: "node", args: ["--test", "test/b.test.mjs"], cwd: ".", timeoutSeconds: 120 });
  assert.deepEqual(preview.graph.nodes[1].worker, { model: "model-b", thinking: "medium", tools: ["read", "write"] });
  assert.equal(preview.graph.nodes[1].maxFixRounds, 1); assert.deepEqual(preview.graph.nodes[2].readPaths, ["src/"]);
  assert.ok(preview.stopConditions.includes("unknown Herdr state"));
  assert.equal(JSON.stringify(previewTicketGraph(run)), JSON.stringify(preview));
});

test("markdown deterministically renders preview details", () => {
  const run = validateRunInput(input()); const markdown = renderTicketGraphMarkdown(run);
  assert.equal(renderTicketGraphMarkdown(run), markdown);
  for (const expected of ["# Delivery preview: preview-run", "A -> B -> C (3 tickets)", "`node` [\"--test\",\"test/b.test.mjs\"]", "parent disposition `approve` required", "Read paths: `src/`", "Fix limit: 1", "unknown Herdr state"]) assert.match(markdown, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
