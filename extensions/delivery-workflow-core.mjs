export const REVIEWER_MODEL = "9router/cc/claude-opus-5-5";
export const WORKER_MODEL = "9router/cx/gpt-5.6-sol";

import fs from "node:fs";
import path from "node:path";

const MAX_CONTRACT_BYTES = 128 * 1024;

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

function validationCommand(args) {
  if (args.validation !== undefined) {
    if (!args.validation || typeof args.validation !== "object" || Array.isArray(args.validation) || Object.keys(args.validation).some((key) => !["runner", "script"].includes(key))) return { error: "validation must contain only runner and script." };
    if (args.validation.runner !== "npm" || typeof args.validation.script !== "string" || !/^[A-Za-z0-9_.:-]+$/.test(args.validation.script)) return { error: "validation must be { runner: \"npm\", script: <safe package script> }." };
    return { command: `npm run ${args.validation.script}` };
  }
  if (!safeValidationCommand(args.validationCommand)) return { error: "validationCommand must be one allowlisted test command without shell operators; use npm test, npm run <safe-script>, or structured validation." };
  return { command: args.validationCommand };
}

function contractFile(cwd, value, key) {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) return { error: `${key} must contain 1–4096 characters.` };
  const root = fs.realpathSync(cwd);
  const scratch = path.join(root, ".scratch");
  const requested = path.resolve(root, value);
  const relative = path.relative(scratch, requested);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return { error: `${key} must be a contained file under repository .scratch/.` };
  let stat;
  let real;
  try {
    stat = fs.lstatSync(requested);
    real = fs.realpathSync(requested);
  } catch {
    return { error: `${key} must exist.` };
  }
  const realRelative = path.relative(scratch, real);
  if (!stat.isFile() || stat.isSymbolicLink() || realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) return { error: `${key} must be a regular, non-linked file contained under repository .scratch/.` };
  if (stat.size > MAX_CONTRACT_BYTES) return { error: `${key} exceeds ${MAX_CONTRACT_BYTES} bytes.` };
  const content = fs.readFileSync(real);
  if (content.includes(0)) return { error: `${key} must be UTF-8 text, not binary.` };
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(content);
  return { content: decoded };
}

function artifactOutputs(value) {
  if (value === undefined) return { paths: [] };
  if (!Array.isArray(value) || value.length > 16 || value.some((item) => typeof item !== "string" || !item || item.length > 1024 || !item.startsWith(".scratch/") || /^[/\\]|(?:^|[/\\])\.\.(?:[/\\]|$)/.test(item) || /[\u0000-\u001f\u007f]/.test(item))) return { error: "artifactOutputs must contain at most 16 bounded relative .scratch/ paths without traversal or control characters." };
  return { paths: value };
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

export function resolveTicket(args, context = { cwd: process.cwd() }) {
  const allowed = [
    "ticketId", "ticketPath", "contextBundle", "validationCommand", "validation", "artifactOutputs",
    "ownedFiles", "forbiddenFiles", "isolated", "maxFixRounds",
  ];
  const keysError = exactKeys(args, allowed);
  if (keysError) return { error: keysError };
  const ticketIdError = text(args, "ticketId", 128, true);
  if (ticketIdError) return { error: ticketIdError };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.ticketId)) return { error: "ticketId must be a safe workflow key." };
  if ((args.validationCommand === undefined) === (args.validation === undefined)) return { error: "Specify exactly one of validationCommand or validation." };
  if (args.validationCommand !== undefined) {
    const error = text(args, "validationCommand", 2000, true);
    if (error) return { error };
  }
  const validated = validationCommand(args);
  if (validated.error) return validated;
  const contextFile = contractFile(context.cwd, args.contextBundle, "contextBundle");
  if (contextFile.error) return contextFile;
  const ticketFile = contractFile(context.cwd, args.ticketPath, "ticketPath");
  if (ticketFile.error) return ticketFile;
  if (Buffer.byteLength(contextFile.content) + Buffer.byteLength(ticketFile.content) > MAX_CONTRACT_BYTES) return { error: `Contract inputs exceed ${MAX_CONTRACT_BYTES} aggregate bytes.` };
  const outputs = artifactOutputs(args.artifactOutputs);
  if (outputs.error) return outputs;
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
    `Immutable context bundle (${args.contextBundle}):\n${contextFile.content}`,
    `Immutable ticket (${args.ticketPath}):\n${ticketFile.content}`,
    `Owned files/contracts: ${args.ownedFiles.join(", ") || "none declared"}`,
    `Forbidden files: ${args.forbiddenFiles.join(", ") || "none declared"}`,
    `Validation command: ${validated.command}`,
    "Implement only approved ticket scope. You are sole writer for this checkout/worktree.",
    "Run focused validation. Ask supervisor instead of making unapproved product, architecture, dependency, migration, security, or public-API decisions.",
    "Report changed files, validation evidence, residual risks, and any blocked decision.",
  ].join("\n");

  const reviewTask = [
    `Review implementation for ticket ${args.ticketId}.`,
    `Use this same immutable contract content:\n${contextFile.content}\n\n${ticketFile.content}`,
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
    gate: validated.command,
    artifactOutputs: outputs.paths,
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
    task: ${JSON.stringify(reviewTask)} + "\\nCandidate evidence: " + JSON.stringify({ output: candidate.output, outputReference: candidate.outputReference, outputPathMapping: candidate.outputPathMapping, artifactPaths: candidate.artifactPaths })
  });
  if (!review.ok || review.structuredOutput?.verdict === "blocked") {
    await state.set(ticketKey, { status: "blocked", attempt: round + 1, writerRunId: candidate.runId ?? null, reviewRunId: review.runId ?? null, nextAction: "parent decision" });
    return { ticketId: ${JSON.stringify(args.ticketId)}, status: "blocked", candidate, review };
  }
  if (review.structuredOutput?.verdict === "ok") {
    await state.set(ticketKey, { status: "done", attempt: round + 1, writerRunId: candidate.runId ?? null, reviewRunId: review.runId ?? null, nextAction: "parent acceptance" });
    return { ticketId: ${JSON.stringify(args.ticketId)}, status: "done", candidate, review, outputReference: candidate.outputReference, outputPathMapping: candidate.outputPathMapping, artifactPaths: candidate.artifactPaths };
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
