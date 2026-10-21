import assert from "node:assert/strict";
import { resolveReview, resolveTicket, REVIEWER_MODEL, WORKER_MODEL } from "../extensions/delivery-workflow-core.mjs";

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
});
assert.ok(ticket.script?.includes('status: "active"'));
assert.ok(ticket.script?.includes('status: "review"'));
assert.ok(ticket.script?.includes('status: "needs_fix"'));
assert.ok(ticket.script?.includes('status: "done"'));
assert.ok(ticket.script?.includes('status: "blocked"'));
assert.ok(ticket.script?.includes('resume: candidate.runId'));
assert.ok(ticket.script?.includes('"worktree":true'));
assert.ok(ticket.script?.includes('"gate":"node --test"'));
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
assert.deepEqual(resolveTicket({
  ticketId: "T001",
  ticketPath: "a",
  contextBundle: "b",
  validationCommand: "echo ok\nrm -rf x",
  ownedFiles: [],
  forbiddenFiles: [],
  isolated: false,
  maxFixRounds: 0,
}), { error: "validationCommand must be one allowlisted test command without shell operators." });
assert.deepEqual(resolveTicket({
  ticketId: "T001",
  ticketPath: "a",
  contextBundle: "b",
  validationCommand: "node --test; rm -rf x",
  ownedFiles: [],
  forbiddenFiles: [],
  isolated: false,
  maxFixRounds: 0,
}), { error: "validationCommand must be one allowlisted test command without shell operators." });

console.log("delivery-workflow smoke: ok");
