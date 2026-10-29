import { executionContractDigest, validateExecutionContract, verifyExecutionApproval, admitExecutionOperation } from "./execution-contract.mjs";

const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const phases = new Set(["approved", "implementing", "diagnosing", "validating", "reviewing", "repairing", "completed", "escalated", "stopped", "recovery_unknown"]);
const kinds = new Set(["verify", "launch", "repair", "validate", "review", "triage", "diagnose", "verifyProgress"]);

// ponytail: read-only audit, not resume authorization; host adapter must prove live identity before any continuation.
export function inspectExecutionRecovery({ contract, approval, store, observations, now = Date.now() }) {
  const issues = [];
  const blocked = () => ({ status: "recovery_unknown", issues, nextAction: "inspect_and_retain", mutates: false, replayAllowed: false, resumeAllowed: false });
  let approved; let state; let records;
  try {
    approved = validateExecutionContract(contract); verifyExecutionApproval(approved, approval, now);
    state = store.state();
    const digest = executionContractDigest(approved);
    if (!state || state.contractDigest !== digest || !phases.has(state.phase) || !SHA.test(state.candidateCommit) || !Number.isSafeInteger(state.operationCount) || state.operationCount < 0 || state.operationCount > 100_000 || !Array.isArray(state.evidence) || state.evidence.length > state.operationCount) throw new Error("execution state identity is invalid");
    if (new Set(state.evidence).size !== state.evidence.length) throw new Error("duplicate operation evidence");
    // Budget validation does not reset elapsed time or counters, including for terminal runs.
    if (!state.budget || !Number.isSafeInteger(now) || now < 0) throw new Error("recovery time or budget is invalid");
    admitExecutionOperation(approved, state.budget, "validate", Math.min(now, state.budget.deadlineAt - 1));
    if (state.budget.actorLaunches > approved.limits.maxActorLaunches || state.budget.remediationRounds > approved.limits.maxRemediationRounds || state.budget.noProgressAttempts > approved.limits.maxNoProgressAttempts) throw new Error("persisted counters exceed approved limits");
    if (state.budget.contractDigest !== digest) throw new Error("budget contract identity mismatch");
    const listed = store.operations();
    const expected = Array.from({ length: state.operationCount }, (_, i) => `operation-${i + 1}`);
    if (listed.length !== expected.length || expected.some(id => !listed.includes(id))) throw new Error("operation inventory contradicts snapshot; possible interrupted write");
    records = expected.map(id => ({ id, ...store.inspect(id) }));
    for (const record of records) {
      const intent = record.intent.intent;
      if (!intent || intent.contractDigest !== digest || intent.deadlineAt !== state.budget.deadlineAt || !SHA.test(intent.candidateCommit) || !kinds.has(intent.kind)) throw new Error(`operation authority mismatch: ${record.id}`);
      const referenced = state.evidence.includes(record.id);
      if (record.status === "recorded" && !referenced) issues.push(`Recorded outcome absent from snapshot: ${record.id}`);
      if (record.status !== "recorded" && referenced) issues.push(`Snapshot claims missing outcome: ${record.id}`);
      if (record.status !== "recorded") issues.push(`Operation outcome unknown: ${record.id}`);
    }
    const launches = records.filter(record => ["launch", "repair", "review", "triage", "diagnose"].includes(record.intent.intent.kind)).length;
    if (launches !== state.budget.actorLaunches) throw new Error("actor launch counter contradicts operation evidence");
    for (const id of state.evidence) if (!expected.includes(id)) throw new Error(`unknown operation evidence: ${id}`);
    if (state.pendingOperation) {
      if (!expected.includes(state.pendingOperation) || state.pendingOperation !== expected.at(-1)) throw new Error("pending operation identity is invalid");
      issues.push(`Pending operation requires explicit reconciliation: ${state.pendingOperation}`);
    }
    if (store.lockInfo()) issues.push("Controller lock retained; ownership must be verified, never stolen");
  } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); return blocked(); }
  if (!observations || observations.verified !== true || observations.repositoryPath !== approved.repositoryPath || observations.parentHead !== approved.baseSha || observations.parentClean !== true || observations.candidateCommit !== state.candidateCommit || observations.candidateClean !== true || observations.contextUnchanged !== true || observations.writerInactive !== true) issues.push("Live repository, context, candidate, or inactive-writer proof missing or contradictory");
  if (issues.length) return blocked();
  if (state.phase === "completed") return { status: "completed", issues: [], nextAction: "inspect_final_report", mutates: false, replayAllowed: false, resumeAllowed: false };
  if (now >= state.budget.deadlineAt) return { status: "blocked", issues: ["Original execution deadline exhausted"], nextAction: "request_explicit_contract_amendment", mutates: false, replayAllowed: false, resumeAllowed: false };
  return { status: "checkpoint_verified", issues: [], nextAction: "explicit_resume_required", mutates: false, replayAllowed: false, resumeAllowed: false };
}

export function verifyExecutionActorIdentity(expected, live) {
  const fields = ["agentId", "name", "workspace", "pane", "worktreePath", "repositoryPath", "model", "startedAt", "attemptId", "nonce"];
  if (!expected || !live || fields.some(field => typeof expected[field] !== "string" || !expected[field] || expected[field].includes("\0") || expected[field] !== live[field])) return false;
  return ["working", "idle", "done", "blocked"].includes(live.status);
}
