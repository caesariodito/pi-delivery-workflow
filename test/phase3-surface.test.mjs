import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { previewTicketGraph, renderTicketGraphMarkdown, validateRunInput } from "../extensions/lib/scheduler.mjs";

const source = fs.readFileSync(new URL("../extensions/delivery-workflow.ts", import.meta.url), "utf8");

function previewInput() {
  return {
    runId: "surface-preview",
    objective: "Inspect graph",
    baseSha: "a".repeat(40),
    integrationValidation: { executable: "node", args: ["--test"], timeoutSeconds: 300 },
    tickets: [{
      id: "R1", mode: "review", goal: "Review", definitionOfDone: "Verdict recorded", dependencies: [],
      ownedPaths: [], readPaths: ["extensions/"],
      worker: { name: "reviewer", kind: "reviewer", model: "model", thinking: "medium", tools: ["read"] },
      validation: { executable: "node", args: ["--test", "test/phase3-surface.test.mjs"] }, maxFixRounds: 0,
      context: { observableBehavior: ["Preview shown"], acceptanceExamples: ["No launch"], nonGoals: [], entryPoints: [], invariants: ["Read only"], expectedValidation: [], unresolvedDecisions: [] },
    }],
  };
}

test("public source registers preview and disposition with exact safe routing", () => {
  assert.match(source, /register\("delivery_preview"[\s\S]*validateRunInput\(input\)[\s\S]*previewTicketGraph\(run\)[\s\S]*renderTicketGraphMarkdown\(run\)/);
  assert.doesNotMatch(source.match(/register\("delivery_preview"[\s\S]*?\}\);/)?.[0] ?? "", /core\.start/);
  assert.match(source, /register\("delivery_dispose"[\s\S]*Type\.Literal\("approve"\)[\s\S]*Type\.Literal\("changes_requested"\)[\s\S]*Type\.Literal\("blocked"\)[\s\S]*core\.dispose/);
  assert.match(source, /\["delivery_status", "delivery_preview"\]\.includes\(name\)/);
  assert.match(source, /Type\.Tuple\(\[Type\.Literal\("read"\)\]\)/);
  assert.match(source, /ownedPaths: Type\.Array\(Text\(4096\), \{ maxItems: 0 \}\)/);
  assert.match(source, /maxFixRounds: Type\.Optional\(Type\.Literal\(0\)\)/);
  assert.doesNotMatch(source, /shell\s*:/);
});

test("dependency-free preview validation stays deterministic and read-only", () => {
  const input = previewInput(); const before = structuredClone(input); const run = validateRunInput(input);
  const preview = previewTicketGraph(run); const markdown = renderTicketGraphMarkdown(run);
  assert.deepEqual(input, before); assert.equal(JSON.stringify(previewTicketGraph(run)), JSON.stringify(preview)); assert.equal(renderTicketGraphMarkdown(run), markdown);
  assert.deepEqual(preview.graph.nodes[0].ownedPaths, []); assert.deepEqual(preview.graph.nodes[0].readPaths, ["extensions/"]); assert.deepEqual(preview.graph.nodes[0].worker.tools, ["read"]); assert.equal(preview.graph.nodes[0].maxFixRounds, 0);
});
