import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { contract } from "./fixtures/execution-contract.mjs";
import { executionContractDigest } from "../extensions/lib/execution-contract.mjs";
import { openExecutionStore } from "../extensions/lib/execution-store.mjs";
import { runExecutionLoop } from "../extensions/lib/execution-loop.mjs";
async function scenario(t, overrides = {}, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "execution-loop-"))); fs.chmodSync(root, 0o700); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const c = contract(); options.configure?.(c); const candidateCommit = "b".repeat(40); const calls = [];
  const runtime = { async verify() { return { verified: true }; }, async launch() { calls.push("launch"); return { status: "done" }; }, async validate() { calls.push("validate"); return { passed: true, candidateCommit, coveredCriteria: ["A1"] }; }, async review() { calls.push("review"); return { candidateCommit, verdict: "approve", summary: "No concrete defects", findings: [], residualRisks: [] }; }, async triage() { throw new Error("unexpected triage"); }, async diagnose() { return { approachKey: "boundary", hypothesis: "Boundary comparison", evidenceRefs: ["failed-check.log"] }; }, async repair() { calls.push("repair"); return { status: "done" }; }, async verifyProgress() { return false; }, ...overrides };
  const store = openExecutionStore(root);
  const result = await runExecutionLoop({ contract: c, approval: { contractDigest: executionContractDigest(c), approvedBy: "operator", approvedAt: "2026-10-29T00:00:00.000Z" }, store, runtime, now: options.now || (() => Date.parse("2026-10-29T01:00:00.000Z")), signal: options.signal });
  return { result, calls, store, root };
}

test("serial loop completes only after final complete validation and fresh review", async t => {
  const { result, calls, store } = await scenario(t);
  assert.equal(result.phase, "completed"); assert.deepEqual(calls, ["launch", "validate", "review", "validate", "review"]); assert.equal(store.lockInfo(), null); assert.equal(result.report.publication, "not_authorized");
});

test("failed validation repairs internally without human disposition", async t => {
  let checks = 0; const candidateCommit = "b".repeat(40);
  const { result, calls } = await scenario(t, { async validate() { return ++checks === 1 ? { passed: false, evidence: "boundary fails" } : { passed: true, candidateCommit, coveredCriteria: ["A1"] }; } });
  assert.equal(result.phase, "completed"); assert.ok(calls.includes("repair"));
});

test("identical failed approaches escalate instead of looping", async t => {
  const { result, calls } = await scenario(t, { async validate() { return { passed: false }; } });
  assert.equal(result.phase, "escalated"); assert.match(result.report.reason, /Repeated approach/); assert.equal(calls.filter(c => c === "repair").length, 1);
});

test("uncertain launch retains intent and never replaces actor", async t => {
  const { result, store } = await scenario(t, { async launch() { throw new Error("transport lost"); } });
  assert.equal(result.phase, "recovery_unknown"); assert.equal(store.inspect("operation-2").status, "recovery_unknown"); assert.equal(result.budget.actorLaunches, 1);
});

test("stale review and missing final criterion proof block completion", async t => {
  const stale = await scenario(t, { async review() { return { candidateCommit: "c".repeat(40), verdict: "approve", summary: "ok", findings: [], residualRisks: [] }; } }); assert.equal(stale.result.phase, "escalated"); assert.match(stale.result.report.reason, /stale/);
  const incomplete = await scenario(t, { async validate() { return { passed: true, candidateCommit: "b".repeat(40), coveredCriteria: [] }; } }); assert.equal(incomplete.result.phase, "escalated"); assert.match(incomplete.result.report.reason, /criterion proof/);
});

const defect = (candidateCommit) => ({ candidateCommit, verdict: "changes_requested", summary: "Boundary defect", findings: [{ id: "F1", severity: "high", path: "src/auth.js", line: 12, criterionId: "A1", claim: "Boundary failure", evidence: "Reproduction rejects valid case", impact: "Incorrect access decision", verification: "Run boundary case" }], residualRisks: [] });
const fixes = (review) => review.findings.map(finding => ({ findingId: finding.id, candidateCommit: review.candidateCommit, action: "fix", rationale: "Reproduced against A1", evidenceRefs: ["logs/reproduction.log"] }));

test("final review finding repairs then reruns whole validation and fresh review", async t => {
  let reviews = 0; let repaired = false; const validations = [];
  const { result } = await scenario(t, {
    async validate({ final }) { validations.push(final); return { passed: true, candidateCommit: (repaired ? "c" : "b").repeat(40), coveredCriteria: ["A1"] }; },
    async review({ candidateCommit }) { reviews++; return reviews === 2 ? defect(candidateCommit) : { candidateCommit, verdict: "approve", summary: "No defects", findings: [], residualRisks: [] }; },
    async triage({ review }) { return fixes(review); },
    async repair({ final, step }) { assert.equal(final, true); assert.deepEqual(step.ownedPaths, ["src/", "test/"]); repaired = true; return { status: "done" }; },
  });
  assert.equal(result.phase, "completed"); assert.equal(result.candidateCommit, "c".repeat(40)); assert.deepEqual(validations, [false, true, true]); assert.equal(reviews, 3);
});

test("blocked final reviewer cannot be overridden or converted into repair", async t => {
  let reviews = 0;
  const { result, calls } = await scenario(t, { async review({ candidateCommit }) { return { candidateCommit, verdict: ++reviews === 2 ? "blocked" : "approve", summary: "Missing decisive context", findings: [], residualRisks: [] }; } });
  assert.equal(result.phase, "escalated"); assert.match(result.report.reason, /review remains blocked/); assert.ok(!calls.includes("repair"));
});

test("supervisor diagnosis consumes launch budget and cannot bypass limit", async t => {
  let diagnoses = 0;
  const { result } = await scenario(t, { async validate() { return { passed: false }; }, async diagnose() { diagnoses++; return { approachKey: `attempt-${diagnoses}`, hypothesis: "New hypothesis", evidenceRefs: ["check.log"] }; } }, { configure(c) { c.limits.maxActorLaunches = 2; } });
  assert.equal(result.phase, "escalated"); assert.match(result.report.reason, /launch budget/); assert.equal(diagnoses, 1); assert.equal(result.budget.actorLaunches, 2);
});

test("stop before launch prevents all runtime calls", async t => {
  const stop = new AbortController(); stop.abort(); let invoked = false;
  const { result } = await scenario(t, { async verify() { invoked = true; return { verified: true }; } }, { signal: stop.signal });
  assert.equal(result.phase, "stopped"); assert.equal(invoked, false);
});

test("stop during operation aborts signal and retains uncertain intent", async t => {
  const stop = new AbortController(); let received;
  const { result, store } = await scenario(t, { async launch({ signal }) { received = signal; stop.abort(); return new Promise(() => {}); } }, { signal: stop.signal });
  assert.equal(result.phase, "recovery_unknown"); assert.equal(received.aborted, true); assert.equal(store.inspect("operation-2").status, "recovery_unknown");
});

test("deadline exceeded by runtime return forbids further launches", async t => {
  let time = Date.parse("2026-10-29T01:00:00.000Z");
  const { result, calls } = await scenario(t, { async launch() { time += 14400 * 1000; return { status: "done" }; } }, { now: () => time });
  assert.equal(result.phase, "recovery_unknown"); assert.equal(calls.length, 0); assert.match(result.report.reason, /after execution stopped/);
});

test("failed exact-identity proof prevents writer launch", async t => {
  const { result, calls } = await scenario(t, { async verify() { return { verified: false }; } });
  assert.equal(result.phase, "escalated"); assert.deepEqual(calls, []);
});


test("final review does not reset exhausted remediation allowance", async t => {
  let checks = 0; let reviews = 0; let repairs = 0;
  const { result } = await scenario(t, {
    async validate() { return ++checks === 1 ? { passed: false } : { passed: true, candidateCommit: "b".repeat(40), coveredCriteria: ["A1"] }; },
    async review({ candidateCommit }) { return ++reviews === 2 ? defect(candidateCommit) : { candidateCommit, verdict: "approve", summary: "No defects", findings: [], residualRisks: [] }; },
    async triage({ review }) { return fixes(review); },
    async repair() { repairs++; return { status: "done" }; },
  }, { configure(c) { c.limits.maxRemediationRounds = 1; } });
  assert.equal(result.phase, "escalated"); assert.match(result.report.reason, /remediation budget/); assert.equal(repairs, 1);
});

test("distinct failed approaches hit no-progress bound without resetting total counters", async t => {
  let attempts = 0; let repairs = 0;
  const { result } = await scenario(t, {
    async validate() { return { passed: false }; },
    async diagnose() { return { approachKey: `distinct-${++attempts}`, hypothesis: "Changed hypothesis", evidenceRefs: ["failure.log"] }; },
    async repair() { repairs++; return { status: "failed" }; },
  }, { configure(c) { c.limits.maxActorLaunches = 20; } });
  assert.equal(result.phase, "escalated"); assert.match(result.report.reason, /no-progress budget/); assert.equal(repairs, 2); assert.equal(result.budget.remediationRounds, 2); assert.equal(result.budget.noProgressAttempts, 2);
});
