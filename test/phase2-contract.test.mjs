import assert from "node:assert/strict";
import test from "node:test";
import { validateRunInput } from "../extensions/lib/scheduler.mjs";

function input() {
  return {
    runId: "phase-2-contract",
    objective: "Validate Phase 2 ticket controls",
    baseSha: "a".repeat(40),
    tickets: [{
      id: "P2-01",
      goal: "Add contracts",
      definitionOfDone: "Contracts validated",
      dependencies: [],
      ownedPaths: ["extensions/lib/scheduler.mjs"],
      worker: { name: "contract-worker", kind: "worker", model: "model", thinking: "medium", tools: ["read"] },
      validation: { executable: "node", args: ["--test"] },
    }],
  };
}

const fields = [
  ["maxFixRounds", 0, 1],
  ["timeoutSeconds", 60, 7200],
  ["validationTimeoutSeconds", 30, 1800],
];

for (const [field, minimum, maximum] of fields) {
  test(`${field} accepts inclusive bounds and rejects invalid values`, () => {
    for (const value of [minimum, maximum]) {
      const payload = input(); payload.tickets[0][field] = value;
      assert.equal(validateRunInput(payload).tickets[0][field], value);
    }
    for (const value of [minimum - 1, maximum + 1, minimum + 0.5, "300", null]) {
      const payload = input(); payload.tickets[0][field] = value;
      assert.throws(() => validateRunInput(payload), new RegExp(field));
    }
  });
}

test("ticket controls remain strict about unknown properties", () => {
  const payload = input(); payload.tickets[0].timeoutSecond = 300;
  assert.throws(() => validateRunInput(payload), /unknown properties/);
});
