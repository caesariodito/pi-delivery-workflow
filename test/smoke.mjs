import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveReview, resolveTicket, REVIEWER_MODEL, WORKER_MODEL } from "../extensions/delivery-workflow-core.mjs";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-workflow-"));
fs.mkdirSync(path.join(cwd, ".scratch/example/tickets"), { recursive: true });
fs.writeFileSync(path.join(cwd, ".scratch/example/context.md"), "context fixture\n");
fs.writeFileSync(path.join(cwd, ".scratch/example/tickets/T001.md"), "ticket fixture\n");

assert.equal(REVIEWER_MODEL, "9router/cc/claude-opus-5-5");
assert.equal(WORKER_MODEL, "9router/cx/gpt-5.6-sol");

const review = resolveReview({
  kind: "spec",
  artifact: ".scratch/example/spec.md",
  contextBundle: ".scratch/example/context.md",
});
assert.ok(review.script?.includes('"context":"fresh"'));
assert.ok(review.script?.includes(REVIEWER_MODEL));
assert.ok(review.script?.includes('"verdict"'));

const ticket = resolveTicket({
  ticketId: "T001",
  ticketPath: ".scratch/example/tickets/T001.md",
  contextBundle: ".scratch/example/context.md",
  validationCommand: "node --test",
  ownedFiles: ["src/example.js"],
  forbiddenFiles: ["package.json"],
  isolated: true,
  maxFixRounds: 2,
}, { cwd });
assert.ok(ticket.script?.includes('status: "active"'));
assert.ok(ticket.script?.includes('status: "review"'));
assert.ok(ticket.script?.includes('status: "needs_fix"'));
assert.ok(ticket.script?.includes('status: "done"'));
assert.ok(ticket.script?.includes('status: "blocked"'));
assert.ok(ticket.script?.includes('resume: candidate.runId'));
assert.ok(ticket.script?.includes('"worktree":true'));
assert.ok(ticket.script?.includes('"gate":"node --test"'));
assert.ok(ticket.script?.includes("context fixture"));
assert.ok(ticket.script?.includes("ticket fixture"));
assert.ok(ticket.script?.includes(REVIEWER_MODEL));
assert.ok(ticket.script?.includes(WORKER_MODEL));

const transitions = [];
let reviewCount = 0;
const mockRuns = {
  async run(key, params) {
    if (key === "writer-1") return { ok: true, runId: "writer-1", output: "candidate" };
    if (key.startsWith("review-")) {
      reviewCount += 1;
      return {
        ok: true,
        runId: key,
        structuredOutput: reviewCount === 1
          ? { verdict: "needs_fix", findings: [{ severity: "P1", location: "fixture", problem: "first pass", action: "fix" }], summary: "fix" }
          : { verdict: "ok", findings: [], summary: "clean" },
      };
    }
    if (key.startsWith("fix-")) {
      assert.equal(params.resume, "writer-1");
      return { ok: true, runId: "writer-2", output: "fixed" };
    }
    throw new Error(`unexpected run ${key}`);
  },
};
const mockState = { async set(key, value) { transitions.push([key, value.status]); } };
const execute = new Function("runs", "state", `return (async () => {${ticket.script}})()`);
const result = await execute(mockRuns, mockState);
assert.equal(result.status, "done");
assert.deepEqual(transitions.map(([, status]) => status), ["active", "review", "needs_fix", "review", "done"]);

assert.deepEqual(resolveReview({ kind: "bad", artifact: "a", contextBundle: "b" }), {
  error: "kind must be spec, plan, or implementation.",
});
assert.deepEqual(resolveTicket({
  ticketId: "bad id",
  ticketPath: "a",
  contextBundle: "b",
  validationCommand: "true",
  ownedFiles: [],
  forbiddenFiles: [],
  isolated: false,
  maxFixRounds: 0,
}), { error: "ticketId must be a safe workflow key." });
for (const validationCommand of ["scripts/validate-sec-0.sh", "npm run test && rm -rf x", "echo ok\nrm -rf x"]) {
  assert.match(resolveTicket({
    ticketId: "T001",
    ticketPath: ".scratch/example/tickets/T001.md",
    contextBundle: ".scratch/example/context.md",
    validationCommand,
    ownedFiles: [],
    forbiddenFiles: [],
    isolated: false,
    maxFixRounds: 0,
  }, { cwd }).error, /allowlisted test command/);
}

const structured = resolveTicket({
  ticketId: "SEC-0",
  ticketPath: ".scratch/example/tickets/T001.md",
  contextBundle: ".scratch/example/context.md",
  validation: { runner: "npm", script: "validate:sec-0" },
  artifactOutputs: [".scratch/example/evidence/metadata.json", ".scratch/example/evidence/home.png"],
  ownedFiles: [".scratch/example/evidence/**"],
  forbiddenFiles: ["tracked repository files"],
  isolated: true,
  maxFixRounds: 2,
}, { cwd });
assert.ok(structured.script?.includes('"gate":"npm run validate:sec-0"'));
assert.ok(structured.script?.includes('"artifactOutputs":[".scratch/example/evidence/metadata.json",".scratch/example/evidence/home.png"]'));
assert.ok(structured.script?.includes("outputPathMapping: candidate.outputPathMapping"));

for (const [ticketPath, expected] of [
  ["../secret.md", /contained file under repository \.scratch/],
  [".scratch/example/missing.md", /must exist/],
]) {
  assert.match(resolveTicket({ ticketId: "T001", ticketPath, contextBundle: ".scratch/example/context.md", validationCommand: "npm test", ownedFiles: [], forbiddenFiles: [], isolated: true, maxFixRounds: 0 }, { cwd }).error, expected);
}
fs.symlinkSync(path.join(cwd, ".scratch/example/context.md"), path.join(cwd, ".scratch/example/link.md"));
assert.match(resolveTicket({ ticketId: "T001", ticketPath: ".scratch/example/link.md", contextBundle: ".scratch/example/context.md", validationCommand: "npm test", ownedFiles: [], forbiddenFiles: [], isolated: true, maxFixRounds: 0 }, { cwd }).error, /non-linked/);
fs.writeFileSync(path.join(cwd, ".scratch/example/large.md"), "x".repeat(128 * 1024 + 1));
assert.match(resolveTicket({ ticketId: "T001", ticketPath: ".scratch/example/large.md", contextBundle: ".scratch/example/context.md", validationCommand: "npm test", ownedFiles: [], forbiddenFiles: [], isolated: true, maxFixRounds: 0 }, { cwd }).error, /exceeds/);

console.log("delivery-workflow smoke: ok");
