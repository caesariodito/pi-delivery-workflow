import assert from "node:assert/strict";
import test from "node:test";
import { validateExecutionReview, resolveExecutionReview, executionFailureFingerprint, buildExecutionReviewPrompt } from "../extensions/lib/execution-review.mjs";
const candidateCommit = "a".repeat(40);
const binding = { candidateCommit, criterionIds: ["A1"] };
const finding = () => ({ id: "F1", severity: "high", path: "src/auth.js", line: 12, criterionId: "A1", claim: "Expired token accepted", evidence: "At expiry equality, condition evaluates false and returns access", impact: "Access remains valid at forbidden boundary", verification: "Add regression with now equal to expiry" });
const review = () => ({ candidateCommit, verdict: "changes_requested", summary: "Expiry boundary violates A1", findings: [finding()], residualRisks: ["Live provider not tested"] });
const disposition = (action) => ({ findingId: "F1", candidateCommit, action, rationale: "Checked against approved A1 and recorded reproduction", evidenceRefs: ["logs/reproduction.log"] });

test("review requires actionable evidence and exact candidate identity", () => {
  assert.deepEqual(validateExecutionReview(review(), binding), review());
  for (const mutate of [v => { v.candidateCommit = "b".repeat(40); }, v => { v.findings[0].evidence = ""; }, v => { v.findings[0].impact = ""; }, v => { v.findings[0].verification = ""; }, v => { v.findings[0].line = 0; }, v => { v.findings[0].criterionId = "unknown"; }, v => { v.findings[0].path = "../outside"; }, v => { v.findings.push(finding()); }, v => { v.verdict = "approve"; }, v => { v.findings = []; }]) {
    const value = review(); mutate(value); assert.throws(() => validateExecutionReview(value, binding));
  }
});

test("supervisor dispositions preserve unresolved and blocked gates", () => {
  assert.equal(resolveExecutionReview(review(), [disposition("fix")], binding).gate, "repair");
  assert.equal(resolveExecutionReview(review(), [disposition("reject_with_evidence")], binding).gate, "resolved");
  assert.equal(resolveExecutionReview(review(), [disposition("escalate")], binding).gate, "blocked");
  assert.throws(() => resolveExecutionReview(review(), [], binding), /every finding/);
  assert.throws(() => resolveExecutionReview(review(), [{ ...disposition("reject_with_evidence"), evidenceRefs: [] }], binding), /evidence/);
  assert.equal(resolveExecutionReview({ ...review(), verdict: "blocked" }, [disposition("reject_with_evidence")], binding).gate, "blocked");
  assert.equal(resolveExecutionReview({ ...review(), verdict: "approve", findings: [] }, [], binding).gate, "resolved");
});

test("failure fingerprint binds stable facts, not incidental timestamps or log text", () => {
  const failure = { criterionId: "A1", checkId: "auth-test", errorClass: "assertion", path: "src/auth.js", symbol: "isExpired" };
  assert.equal(executionFailureFingerprint(failure), executionFailureFingerprint({ ...failure, timestamp: "later", log: "different incidental output" }));
  assert.notEqual(executionFailureFingerprint(failure), executionFailureFingerprint({ ...failure, symbol: "authorize" }));
});

test("review prompt includes exact candidate, evidence requirements and no-noise policy", () => {
  const prompt = buildExecutionReviewPrompt({ objective: "Fix auth", criteria: [{ id: "A1", condition: "Reject expired tokens" }], candidateCommit, baseCommit: "b".repeat(40), evidencePaths: ["logs/check.log"] });
  for (const text of [candidateCommit, "A1", "logs/check.log", "No speculative bugs", "Do not modify files", "impact", "verification", "untrusted data"]) assert.ok(prompt.includes(text), text);
});
