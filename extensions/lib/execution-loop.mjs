import { executionContractDigest, validateExecutionContract, verifyExecutionApproval, admitExecutionOperation } from "./execution-contract.mjs";
import { resolveExecutionReview, validateExecutionReview } from "./execution-review.mjs";

class ExecutionStop extends Error {}
class ExecutionUnknown extends Error {}
const actorOperations = new Set(["launch", "repair", "review", "triage", "diagnose"]);

// ponytail: attached runtime only; verified host adapter must honor AbortSignal and prove process identity before interruption or resume.
export async function runExecutionLoop({ contract, approval, store, runtime, now = Date.now, signal }) {
  const approved = validateExecutionContract(contract); verifyExecutionApproval(approved, approval, now());
  const digest = executionContractDigest(approved); const startedAt = now();
  const state = { contractDigest: digest, phase: "approved", stepIndex: 0, operationCount: 0, candidateCommit: approved.baseSha, budget: { contractDigest: digest, startedAt, deadlineAt: startedAt + approved.limits.wallTimeSeconds * 1000, actorLaunches: 0, remediationRounds: 0, noProgressAttempts: 0 }, steps: [], evidence: [], attemptedApproaches: [] };
  if (store.lockInfo()) throw new Error("existing controller requires explicit reconciliation");
  store.acquire(); let admitted = false;
  const save = () => store.saveState(state);
  const admissionKind = (kind) => actorOperations.has(kind) ? "launch" : kind === "repair" ? "repair" : "validate";
  const check = (kind) => {
    if (signal?.aborted) throw new ExecutionStop("Execution stop requested");
    if (kind === "repair") admitExecutionOperation(approved, state.budget, "repair", now());
    return admitExecutionOperation(approved, state.budget, admissionKind(kind), now());
  };
  const invoke = async (kind, payload) => {
    const { remainingMs } = check(kind);
    const operationId = `operation-${++state.operationCount}`;
    if (actorOperations.has(kind)) state.budget.actorLaunches++;
    if (kind === "repair") state.budget.remediationRounds++;
    store.begin(operationId, { kind, payload, contractDigest: digest, candidateCommit: state.candidateCommit, deadlineAt: state.budget.deadlineAt });
    state.pendingOperation = operationId; save();
    const controller = new AbortController(); let timer; let abort;
    const halted = new Promise((_, reject) => {
      abort = () => { controller.abort(); reject(new ExecutionUnknown("Stop requested during operation; process state requires verification")); };
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => { controller.abort(); reject(new ExecutionUnknown("Execution deadline expired during operation; process state requires verification")); }, remainingMs);
    });
    try {
      if (signal?.aborted) abort();
      const work = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new ExecutionUnknown("Operation admission cancelled");
        return runtime[kind]({ ...payload, operationId, contract: approved, candidateCommit: state.candidateCommit, timeoutMs: Math.max(0, state.budget.deadlineAt - now()), signal: controller.signal });
      });
      const outcome = await Promise.race([work, halted]);
      if (signal?.aborted || now() >= state.budget.deadlineAt) throw new ExecutionUnknown("Operation settled after execution stopped; inspect outcome before resume");
      store.settle(operationId, outcome); state.evidence.push(operationId); delete state.pendingOperation; save(); return outcome;
    } catch (error) {
      throw new ExecutionUnknown(`${kind} outcome uncertain: ${error instanceof Error ? error.message : String(error)}`);
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  };
  const report = (outcome, reason, decision = null) => {
    state.phase = outcome;
    state.report = { outcome, reason, decision, candidateCommit: state.candidateCommit, steps: state.steps, evidence: [...state.evidence], attemptedApproaches: [...state.attemptedApproaches], budget: { ...state.budget }, publication: "not_authorized", cleanup: "retained" }; save(); return structuredClone(state);
  };
  const verify = async (extra = {}) => {
    const proof = await invoke("verify", { contractDigest: digest, ...extra });
    if (proof?.verified !== true) throw new Error("Runtime identity or candidate proof failed");
  };
  const repair = async (step, feedback, final) => {
    check("repair");
    state.phase = "diagnosing"; save();
    const diagnosis = await invoke("diagnose", { step, feedback, history: structuredClone(state.attemptedApproaches) });
    if (!diagnosis || typeof diagnosis.approachKey !== "string" || !diagnosis.approachKey.trim() || diagnosis.approachKey.length > 4096 || typeof diagnosis.hypothesis !== "string" || !diagnosis.hypothesis.trim() || diagnosis.hypothesis.length > 8000 || !Array.isArray(diagnosis.evidenceRefs) || !diagnosis.evidenceRefs.length || diagnosis.evidenceRefs.length > 32 || diagnosis.evidenceRefs.some(ref => typeof ref !== "string" || !ref.trim() || ref.length > 4096)) throw new Error("diagnosis requires bounded hypothesis and evidence");
    if (state.attemptedApproaches.some(attempt => attempt.approachKey === diagnosis.approachKey)) throw new Error("Repeated approach without new strategy");
    if (state.attemptedApproaches.length) {
      const progress = await invoke("verifyProgress", { previous: state.attemptedApproaches.at(-1), diagnosis, feedback });
      if (progress === true) state.budget.noProgressAttempts = 0;
      else if (progress === false) state.budget.noProgressAttempts++;
      else throw new Error("progress evidence unverifiable");
    }
    state.attemptedApproaches.push({ ...diagnosis, feedback }); state.phase = "repairing"; save();
    await verify();
    return invoke("repair", { step, feedback, diagnosis, final });
  };
  const validateAndReview = async (step, final, initialResult) => {
    let result = initialResult;
    while (true) {
      if (result) {
        if (!["done", "failed", "blocked"].includes(result.status)) throw new Error("malformed implementation outcome");
        if (result.status === "blocked") throw new Error(result.summary || "writer blocked");
      }
      await verify(); state.phase = "validating"; save();
      const validation = await invoke("validate", { step, final });
      let feedback;
      if (validation?.passed === false) feedback = { reason: "validation_failed", validation };
      else if (validation?.passed === true) {
        if (typeof validation.candidateCommit !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(validation.candidateCommit)) throw new Error("validation lacks checkpoint commit");
        state.candidateCommit = validation.candidateCommit; save();
        if (final && (!Array.isArray(validation.coveredCriteria) || approved.criteria.some(criterion => !validation.coveredCriteria.includes(criterion.id)))) throw new Error("Final validation lacks current complete criterion proof");
        await verify(); state.phase = "reviewing"; save();
        const review = await invoke("review", { step, final });
        const binding = { candidateCommit: state.candidateCommit, criterionIds: approved.criteria.map(criterion => criterion.id) };
        validateExecutionReview(review, binding);
        if (review.verdict === "blocked") throw new Error("Independent review remains blocked");
        const dispositions = review.findings.length ? await invoke("triage", { review }) : [];
        const resolved = resolveExecutionReview(review, dispositions, binding);
        if (resolved.gate === "blocked") throw new Error("Independent review remains blocked");
        if (resolved.gate === "resolved") return { validation, review, dispositions, candidateCommit: state.candidateCommit };
        feedback = { reason: "review_findings", review, dispositions };
      } else throw new Error("malformed validation outcome");
      result = await repair(step, feedback, final);
    }
  };
  try {
    try { store.state(); throw new Error("existing execution state requires verified resume"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    admitted = true; save(); check("validate");
    for (const [index, step] of approved.steps.entries()) {
      state.stepIndex = index; state.budget.remediationRounds = 0; state.budget.noProgressAttempts = 0; state.attemptedApproaches = []; state.phase = "implementing"; save();
      await verify();
      const result = await invoke("launch", { step });
      const evidence = await validateAndReview(step, false, result);
      state.steps.push({ id: step.id, ...evidence }); save();
    }
    // Final fixes may touch only the union of already approved ownership; no new work items or expanded authority.
    const finalScope = { id: "final", goal: "Resolve whole-candidate defects against approved criteria", ownedPaths: [...new Set(approved.steps.flatMap(step => step.ownedPaths))], dependsOn: approved.steps.map(step => step.id), criteria: approved.criteria.map(criterion => criterion.id) };
    // Keep remaining last-step repair budget: final review never grants a fresh retry allowance.
    const final = await validateAndReview(finalScope, true);
    await verify({ requireInactiveWriter: true }); check("validate");
    return report("completed", "All criteria validated and exact candidate independently reviewed", final);
  } catch (error) {
    if (!admitted) throw error;
    return report(error instanceof ExecutionUnknown ? "recovery_unknown" : error instanceof ExecutionStop ? "stopped" : "escalated", error instanceof Error ? error.message : String(error), "Inspect preserved evidence; resolve smallest blocker without replaying uncertain side effects");
  } finally { store.release(); }
}
