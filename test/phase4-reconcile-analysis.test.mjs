import assert from "node:assert/strict";
import test from "node:test";
import { analyzeReconciliation } from "../extensions/lib/scheduler.mjs";

test("reports persisted/live/evidence/Git contradictions without success inference", () => {
  const result = analyzeReconciliation({
    persistedTickets: {
      clean: { status: "cleaned" },
      integrated: { status: "integrated" },
      reviewed: { status: "reviewed" },
      running: { status: "running" },
      validated: { status: "validation_passed" },
    },
    liveTickets: {
      clean: { agentStatus: "idle", workspacePresent: true },
      running: { agentStatus: "idle", identityMatches: false },
      validated: { agentStatus: "done" },
    },
    evidenceTickets: {
      integrated: { integrationVerified: false },
      reviewed: {},
      validated: { validationPassed: false },
    },
    gitTickets: { integrated: { patchIntegrated: false } },
  });

  assert.equal(result.hasContradictions, true);
  assert.equal(result.inferredSuccess, false);
  assert.deepEqual(Object.fromEntries(result.tickets.map((ticket) => [ticket.ticketId, ticket.contradictions.map(({ code }) => code)])), {
    clean: ["cleaned_resource_present"],
    integrated: ["integration_evidence_missing"],
    reviewed: ["review_evidence_missing"],
    running: ["running_agent_not_active", "workspace_identity_mismatch"],
    validated: ["validation_evidence_missing"],
  });
  assert.ok(result.tickets.every((ticket) => ticket.recommendation.action === "inspect_and_retain" && ticket.recommendation.mutates === false));
});

test("unknown live state recommends inspection and never replay", () => {
  const result = analyzeReconciliation({ persistedTickets: { T1: { status: "running" } }, liveTickets: { T1: { agentStatus: "unknown" } } });
  assert.deepEqual(result.tickets[0], {
    ticketId: "T1",
    persistedStatus: "running",
    liveStatus: "unknown",
    contradictions: [{ code: "live_state_unknown", message: "Persisted running state has no known live agent state." }],
    recommendation: { action: "inspect_and_retain", mutates: false },
  });
  assert.ok(!["replay", "resume", "replace", "stop"].includes(result.tickets[0].recommendation.action));
  assert.equal(result.inferredSuccess, false);
});

test("output and safe recommendations are deterministic", () => {
  const input = {
    persistedTickets: { Z: { status: "integrated" }, A: { status: "validation_passed" }, M: { status: "pending" } },
    evidenceTickets: { Z: { integrationVerified: true }, A: { validationPassed: true } },
    gitTickets: { Z: { patchIntegrated: true } },
  };
  const expected = analyzeReconciliation(input);
  assert.deepEqual(expected.tickets.map(({ ticketId, recommendation }) => [ticketId, recommendation.action]), [
    ["A", "verify_patch_then_integrate"],
    ["M", "await_scheduler"],
    ["Z", "verify_then_cleanup"],
  ]);
  assert.deepEqual(analyzeReconciliation(structuredClone(input)), expected);
  assert.equal(expected.hasContradictions, false);
  assert.equal(expected.inferredSuccess, false);
});

test("approved disposed review requires affirmative verdict and unchanged evidence", () => {
  const missing = analyzeReconciliation({
    persistedTickets: { R1: { status: "disposed", disposition: "approve" } },
    evidenceTickets: { R1: {} },
  });
  assert.deepEqual(missing.tickets[0].contradictions.map(({ code }) => code), [
    "disposed_review_approval_missing",
    "disposed_review_parent_unchanged_missing",
    "disposed_review_worktree_unchanged_missing",
  ]);
  assert.equal(missing.tickets[0].recommendation.action, "inspect_and_retain");

  for (const evidence of [
    { reviewVerdict: "changes_requested", parentUnchanged: true, worktreeUnchanged: true },
    { reviewVerdict: "approve", parentUnchanged: false, worktreeUnchanged: true },
    { reviewVerdict: "approve", parentUnchanged: true, worktreeUnchanged: false },
  ]) {
    const adverse = analyzeReconciliation({ persistedTickets: { R1: { status: "disposed", disposition: "approve" } }, evidenceTickets: { R1: evidence } });
    assert.equal(adverse.hasContradictions, true);
    assert.equal(adverse.tickets[0].recommendation.action, "inspect_and_retain");
  }

  const approved = analyzeReconciliation({
    persistedTickets: { R1: { status: "disposed", disposition: "approve" } },
    evidenceTickets: { R1: { reviewVerdict: "approve", parentUnchanged: true, worktreeUnchanged: true } },
  });
  assert.equal(approved.hasContradictions, false);
  assert.equal(approved.tickets[0].recommendation.action, "verify_then_cleanup");
});

test("live done alone remains contradiction, not validation success", () => {
  const result = analyzeReconciliation({ persistedTickets: { T1: { status: "running" } }, liveTickets: { T1: { agentStatus: "done" } } });
  assert.deepEqual(result.tickets[0].contradictions.map(({ code }) => code), ["live_done_not_proof", "running_agent_not_active"]);
  assert.equal(result.tickets[0].recommendation.action, "inspect_and_retain");
  assert.equal(result.inferredSuccess, false);
});
