import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const docs = ["README.md", "CONTRIBUTING.md", "docs/architecture.md", "docs/operator-guide.md", "docs/safety-and-recovery.md", "docs/ticket-contract.md", "docs/tutorial.md", "skills/delivery-workflow/SKILL.md"];
const corpus = docs.map(read).join("\n");

const requiredPlaybooks = [
  ["interruption", /Interruption playbook/i],
  ["reconcile", /Read-only reconcile playbook/i],
  ["review disposition", /Review disposition playbook/i],
  ["timeout and fix", /Timeout and fix playbook/i],
  ["metrics", /Metrics playbook/i],
  ["integration", /Integration playbook/i],
  ["cleanup", /Cleanup playbook/i],
  ["publication", /Publication playbook/i],
];

test("operator guide contains Phase 2-4 playbooks", () => {
  const guide = read("docs/operator-guide.md");
  for (const [name, pattern] of requiredPlaybooks) assert.match(guide, pattern, `missing ${name} playbook`);
});

test("docs preserve runtime safety and bounds", () => {
  for (const pattern of [
    /delivery_reconcile[\s\S]{0,200}read-only/i,
    /maxFixRounds: 1/,
    /timeoutSeconds/,
    /validationTimeoutSeconds/,
    /300 seconds/,
    /approve[\s\S]{0,80}changes_requested[\s\S]{0,80}blocked/,
    /incomplete flag/i,
    /no automatic (?:merge|acceptance)|never auto-accept/i,
    /publication[\s\S]{0,120}(?:separate|explicit)/i,
  ]) assert.match(corpus, pattern);
  assert.doesNotMatch(corpus, /automatic (?:recovery|cleanup|merge|publication) (?:is|runs|occurs|happens)/i);
});

test("ticket docs match strict public bounds and review shape", () => {
  const contract = read("docs/ticket-contract.md");
  assert.match(contract, /fix rounds `0\.\.1`/);
  assert.match(contract, /ticket timeout `60\.\.7200`/);
  assert.match(contract, /validation timeout `30\.\.1800`/);
  assert.match(contract, /empty `ownedPaths`/);
  assert.match(contract, /exactly `read` tool/);
  assert.match(contract, /integration timeout bound is `30\.\.1800`/i);
});

test("all package-facing documentation files exist", () => {
  for (const file of docs) assert.equal(fs.statSync(path.join(root, file)).isFile(), true, file);
});
