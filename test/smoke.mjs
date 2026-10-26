import assert from "node:assert/strict";
import { buildContextPacket, validateRunInput } from "../extensions/lib/scheduler.mjs";

const run = validateRunInput({ runId: "smoke", objective: "Smoke", baseSha: "a".repeat(40), tickets: [{ id: "T1", goal: "Do work", definitionOfDone: "Done", dependencies: [], ownedPaths: ["src/a.js"], worker: { name: "worker", kind: "pi", model: "model", thinking: "medium", tools: ["read", "write"] }, validation: { executable: "node", args: ["--test"] } }] });
const packet = buildContextPacket({ run, ticket: run.tickets[0], repositoryPath: "/repo", worktreePath: "/work", promptPath: "/repo/.scratch/prompt.md", resultPath: "/repo/.scratch/result.json", nonce: "nonce" });
assert.match(packet, /Delivery ticket T1/); assert.match(packet, /delivery_result_write/);
console.log("delivery-workflow smoke: ok");
