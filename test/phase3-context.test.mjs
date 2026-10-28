import assert from "node:assert/strict";
import test from "node:test";
import { buildContextPacket, validateRunInput } from "../extensions/lib/scheduler.mjs";

function input(context) {
  return {
    runId: "phase3-context",
    objective: "Provide implementation context",
    baseSha: "a".repeat(40),
    integrationValidation: { executable: "node", args: ["--test", "test/integration.test.mjs"], cwd: ".", timeoutSeconds: 300 },
    tickets: [{
      id: "P3-01",
      goal: "Add rich context",
      definitionOfDone: "Context appears in packet",
      dependencies: [],
      ownedPaths: ["extensions/lib/scheduler.mjs"],
      worker: { name: "context-worker", kind: "worker", model: "model", thinking: "medium", tools: ["read", "write"] },
      validation: { executable: "node", args: ["--test", "test/phase3-context.test.mjs"] },
      ...(context === undefined ? {} : { context }),
    }],
  };
}

function packet(run) {
  return buildContextPacket({ run, ticket: run.tickets[0], repositoryPath: "/repo", worktreePath: "/work", promptPath: "/prompt", resultPath: "/result", nonce: "nonce" });
}

test("rich ticket context is strict, bounded, and rendered in named sections", () => {
  const context = {
    observableBehavior: ["Operator sees validation command."],
    acceptanceExamples: ["Given integrated patch, validation passes."],
    nonGoals: ["Do not execute validation here."],
    entryPoints: ["validateRunInput"],
    invariants: ["Commands remain executable plus argv."],
    expectedValidation: ["Run focused node tests."],
    unresolvedDecisions: ["None."],
  };
  const run = validateRunInput(input(context));
  const output = packet(run);
  for (const heading of ["Observable behavior", "Acceptance examples", "Non-goals", "Entry points", "Invariants", "Expected validation", "Unresolved decisions", "Integration validation"]) assert.match(output, new RegExp(`## ${heading}`));
  assert.match(output, /Args: \["--test","test\/integration\.test\.mjs"\]/);
  assert.match(output, /Timeout seconds: 300/);
  assert.deepEqual(run.tickets[0].context, context);

  const omitted = packet(validateRunInput(input({ observableBehavior: [], nonGoals: ["No extras."] })));
  assert.doesNotMatch(omitted, /## Observable behavior/);
  assert.match(omitted, /## Non-goals/);

  assert.throws(() => validateRunInput(input({ unknown: [] })), /unknown properties/);
  assert.throws(() => validateRunInput(input({ invariants: Array(33).fill("x") })), /0-32 strings/);
  assert.throws(() => validateRunInput(input({ invariants: [""] })), /1-4000 characters/);
  assert.throws(() => validateRunInput(input({ invariants: ["x\0y"] })), /without NUL/);
});

test("packet retains 64 KiB byte bound", () => {
  const large = Array.from({ length: 32 }, (_, index) => `${index}:${"x".repeat(3997)}`);
  const run = validateRunInput(input({ acceptanceExamples: large }));
  assert.throws(() => packet(run), /exceeds 64 KiB/);
});
