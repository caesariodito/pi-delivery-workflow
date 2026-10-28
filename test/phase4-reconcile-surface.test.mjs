import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const extension = fs.readFileSync(new URL("../extensions/delivery-workflow.ts", import.meta.url), "utf8");
const core = fs.readFileSync(new URL("../extensions/delivery-workflow-core.mjs", import.meta.url), "utf8");

function section(source, start, end) {
  const from = source.indexOf(start); const to = source.indexOf(end, from);
  assert.notEqual(from, -1, `missing ${start}`); assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}

test("delivery_reconcile registers exact read-only tool and command surface", () => {
  assert.match(extension, /const Run = Type\.Object\(\{ runId: Text\(128\) \}, \{ additionalProperties: false \}\)/);
  assert.match(extension, /register\("delivery_reconcile", "Compare persisted, Herdr, evidence, and Git state without mutation\.", Run, core\.reconcile\)/);
  assert.match(extension, /readOnlyHint: \["delivery_status", "delivery_preview"\]\.includes\(name\) \|\| name === "delivery_reconcile"/);
  assert.match(extension, /idempotentHint: \["delivery_status", "delivery_preview", "delivery_cleanup"\]\.includes\(name\) \|\| name === "delivery_reconcile"/);
  assert.doesNotMatch(extension.match(/destructiveHint: [^,]+/)?.[0] ?? "", /delivery_reconcile/);
  assert.match(extension, /pi\.registerCommand\(name,/);
});

test("delivery_reconcile routes only through read-only reconciliation core", () => {
  const reconcile = section(core, "    async reconcile(repositoryPath, input) {", "    async dispose(repositoryPath, input) {");
  assert.match(reconcile, /reconcileObservations\(root, directory, state, herdr\)/);
  assert.match(reconcile, /analyzeReconciliation\(/);
  assert.doesNotMatch(reconcile, /\b(?:save|atomicJson|exclusiveJson|runValidation|executeTicket)\s*\(/);
  assert.doesNotMatch(reconcile, /herdr\.(?:worktreeCreate|worktreeRemove|agentStart|agentPrompt|agentSendKeys|agentStop)\s*\(/);
});
