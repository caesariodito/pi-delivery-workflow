export const REVIEWER_MODEL = "9router/cc/claude-opus-5-5";
export const WORKER_MODEL = "9router/cx/gpt-5.6-sol";

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { enum: ["ok", "needs_fix", "blocked"] },
    findings: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        properties: {
          severity: { enum: ["P0", "P1", "P2"] },
          location: { type: "string" },
          problem: { type: "string" },
          action: { type: "string" },
        },
        required: ["severity", "location", "problem", "action"],
        additionalProperties: false,
      },
    },
    summary: { type: "string" },
  },
  required: ["verdict", "findings", "summary"],
  additionalProperties: false,
};

function exactKeys(args, allowed) {
  const extra = Object.keys(args).filter((key) => !allowed.includes(key));
  return extra.length ? `Unsupported fields: ${extra.join(", ")}.` : undefined;
}

function text(args, key, max, required = true) {
  const value = args[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    return `${key} must contain 1–${max} characters.`;
  }
  return undefined;
}

function safeValidationCommand(command) {
  // ponytail: fixed test-runner forms only; add argv-style resource fields when projects need custom flags.
  if (/[\r\n\0;&|`$()<>\\]/.test(command)) return false;
  return [
    /^(?:npm|pnpm|yarn) (?:test|run [A-Za-z0-9_.:-]+)$/,
    /^bun test$/,
    /^node --test(?: [A-Za-z0-9_./*:-]+)*$/,
    /^(?:python3? -m pytest|pytest)(?: [A-Za-z0-9_./*:=:-]+)*$/,
    /^cargo test(?: [A-Za-z0-9_./*:=:-]+)*$/,
    /^go test(?: [A-Za-z0-9_./*:=:-]+)*$/,
    /^dotnet test(?: [A-Za-z0-9_./*:=:-]+)*$/,
  ].some((pattern) => pattern.test(command));
}

export function resolveReview(args) {
  const keysError = exactKeys(args, ["kind", "artifact", "contextBundle", "focus"]);
  if (keysError) return { error: keysError };
  if (!['spec', 'plan', 'implementation'].includes(args.kind)) {
    return { error: "kind must be spec, plan, or implementation." };
  }
  for (const [key, max, required] of [
    ["artifact", 4096, true],
    ["contextBundle", 4096, true],
    ["focus", 4000, false],
  ]) {
    const error = text(args, key, max, required);
    if (error) return { error };
  }

  const task = [
    `Review the ${args.kind} artifact at ${args.artifact}.`,
    `Read the stable context bundle at ${args.contextBundle} first.`,
    args.focus ? `Review focus: ${args.focus}` : "",
    "Authority: read-only. Do not edit project or artifact files.",
    "Return only concrete, actionable findings supported by the artifact, repository source, or an explicit contract.",
    "Do not rewrite the artifact. Mark clean work as verdict ok. Use blocked only for an unapproved product, architecture, security, or scope decision.",
  ].filter(Boolean).join("\n");

  return {
    script: `return runs.run("review", ${JSON.stringify({
      label: `Review ${args.kind}`,
      agent: "reviewer",
      task,
      context: "fresh",
      model: REVIEWER_MODEL,
      outputSchema: REVIEW_SCHEMA,
    })});`,
  };
}

export function resolveTicket(args) {
  const allowed = [
    "ticketId", "ticketPath", "contextBundle", "validationCommand",
    "ownedFiles", "forbiddenFiles", "isolated", "maxFixRounds",
  ];
  const keysError = exactKeys(args, allowed);
  if (keysError) return { error: keysError };
  for (const [key, max] of [["ticketId", 128], ["ticketPath", 4096], ["contextBundle", 4096], ["validationCommand", 2000]]) {
    const error = text(args, key, max, true);
    if (error) return { error };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.ticketId)) {
    return { error: "ticketId must be a safe workflow key." };
  }
  if (!safeValidationCommand(args.validationCommand)) {
    return { error: "validationCommand must be one allowlisted test command without shell operators." };
  }
  for (const key of ["ownedFiles", "forbiddenFiles"]) {
    if (!Array.isArray(args[key]) || args[key].length > 64 || args[key].some((item) => typeof item !== "string" || !item.trim() || item.length > 1024)) {
      return { error: `${key} must be an array of at most 64 non-empty paths.` };
    }
  }
  if (typeof args.isolated !== "boolean") return { error: "isolated must be boolean." };
  if (!Number.isSafeInteger(args.maxFixRounds) || args.maxFixRounds < 0 || args.maxFixRounds > 3) {
    return { error: "maxFixRounds must be an integer from 0 through 3." };
  }

  const packet = [
    `Ticket: ${args.ticketId}`,
    `Read ${args.contextBundle}, then ${args.ticketPath}.`,
    `Owned files/contracts: ${args.ownedFiles.join(", ") || "none declared"}`,
    `Forbidden files: ${args.forbiddenFiles.join(", ") || "none declared"}`,
    `Validation command: ${args.validationCommand}`,
    "Implement only approved ticket scope. You are sole writer for this checkout/worktree.",
    "Run focused validation. Ask supervisor instead of making unapproved product, architecture, dependency, migration, security, or public-API decisions.",
    "Report changed files, validation evidence, residual risks, and any blocked decision.",
  ].join("\n");

  const reviewTask = [
    `Review implementation for ticket ${args.ticketId}.`,
    `Read ${args.contextBundle} and ${args.ticketPath}.`,
    "Inspect candidate handoff artifacts, captured patch, and validation evidence supplied below. Authority: read-only; do not edit.",
    "Return actionable findings only. Use needs_fix for bounded implementation defects and blocked for decisions outside approved scope.",
  ].join("\n");

  const writer = {
    label: `Implement ${args.ticketId}`,
    agent: "worker",
    task: packet,
    context: "fresh",
    model: WORKER_MODEL,
    worktree: args.isolated,
    gate: args.validationCommand,
  };
  const reviewer = {
    label: `Review ${args.ticketId}`,
    agent: "reviewer",
    task: reviewTask,
    context: "fresh",
    model: REVIEWER_MODEL,
    outputSchema: REVIEW_SCHEMA,
  };

  const script = `
const ticketKey = ${JSON.stringify(`ticket-${args.ticketId}`)};
await state.set(ticketKey, { status: "active", attempt: 1, nextAction: "implement" });
let candidate = await runs.run("writer-1", ${JSON.stringify(writer)});
if (!candidate.ok) {
  await state.set(ticketKey, { status: "blocked", attempt: 1, writerRunId: candidate.runId ?? null, nextAction: "inspect writer failure" });
  return { ticketId: ${JSON.stringify(args.ticketId)}, status: "blocked", candidate };
}
let review;
for (let round = 0; round <= ${args.maxFixRounds}; round += 1) {
  await state.set(ticketKey, { status: "review", attempt: round + 1, writerRunId: candidate.runId ?? null, nextAction: "review" });
  review = await runs.run("review-" + (round + 1), {
    ...${JSON.stringify(reviewer)},
    task: ${JSON.stringify(reviewTask)} + "\\nCandidate evidence: " + JSON.stringify({ output: candidate.output, outputReference: candidate.outputReference, artifactPaths: candidate.artifactPaths })
  });
  if (!review.ok || review.structuredOutput?.verdict === "blocked") {
    await state.set(ticketKey, { status: "blocked", attempt: round + 1, writerRunId: candidate.runId ?? null, reviewRunId: review.runId ?? null, nextAction: "parent decision" });
    return { ticketId: ${JSON.stringify(args.ticketId)}, status: "blocked", candidate, review };
  }
  if (review.structuredOutput?.verdict === "ok") {
    await state.set(ticketKey, { status: "done", attempt: round + 1, writerRunId: candidate.runId ?? null, reviewRunId: review.runId ?? null, nextAction: "parent acceptance" });
    return { ticketId: ${JSON.stringify(args.ticketId)}, status: "done", candidate, review };
  }
  if (round === ${args.maxFixRounds}) break;
  await state.set(ticketKey, { status: "needs_fix", attempt: round + 1, writerRunId: candidate.runId ?? null, reviewRunId: review.runId ?? null, nextAction: "apply accepted findings" });
  if (!candidate.runId) {
    await state.set(ticketKey, { status: "blocked", attempt: round + 1, reviewRunId: review.runId ?? null, nextAction: "writer is not resumable" });
    return { ticketId: ${JSON.stringify(args.ticketId)}, status: "blocked", candidate, review, reason: "writer is not resumable" };
  }
  const fixTask = ${JSON.stringify(packet)} + "\\nApply only these accepted review findings, then rerun the ticket validation command:\\n" + JSON.stringify(review.structuredOutput?.findings ?? []);
  candidate = await runs.run("fix-" + (round + 1), {
    resume: candidate.runId,
    label: "Fix ${args.ticketId}",
    task: fixTask
  });
  if (!candidate.ok) {
    await state.set(ticketKey, { status: "blocked", attempt: round + 2, writerRunId: candidate.runId ?? null, nextAction: "inspect fix failure" });
    return { ticketId: ${JSON.stringify(args.ticketId)}, status: "blocked", candidate, review };
  }
}
await state.set(ticketKey, { status: "blocked", attempt: ${args.maxFixRounds + 1}, writerRunId: candidate.runId ?? null, reviewRunId: review?.runId ?? null, nextAction: "fix-round limit reached" });
return { ticketId: ${JSON.stringify(args.ticketId)}, status: "blocked", candidate, review, reason: "fix-round limit reached" };
`;
  return { script };
}
