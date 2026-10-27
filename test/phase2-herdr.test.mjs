import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHerdrAdapter, HERDR_MAX_TIMEOUT_MS } from "../extensions/lib/herdr.mjs";

const fake = fileURLToPath(new URL("./fixtures/herdr/fake-herdr.mjs", import.meta.url));

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phase2-herdr-"));
  const argvLog = path.join(dir, "argv.jsonl");
  fs.writeFileSync(argvLog, "");
  return {
    adapter: createHerdrAdapter({
      executable: process.execPath,
      executableArgs: [fake],
      env: { HERDR_ARGV_LOG: argvLog },
    }),
    argv: () => fs.readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse),
  };
}

test("agentWait sends exact bounded argv at public per-call ceiling", async () => {
  const { adapter, argv } = harness();
  await adapter.agentWait({ target: "worker", until: ["done", "blocked"], timeout: HERDR_MAX_TIMEOUT_MS });
  assert.deepEqual(argv(), [[
    "agent", "wait", "worker",
    "--until", "done",
    "--until", "blocked",
    "--timeout", "300000",
  ]]);
});

test("all timeout-bearing public Herdr calls reject above per-call ceiling", async () => {
  const { adapter, argv } = harness();
  const timeout = HERDR_MAX_TIMEOUT_MS + 1;
  for (const operation of [
    adapter.agentStart({ name: "worker", kind: "pi", pane: "w1:p1", timeout }),
    adapter.agentPrompt({ target: "worker", prompt: "task", wait: true, timeout }),
    adapter.agentWait({ target: "worker", timeout }),
  ]) await assert.rejects(operation, /timeout must be an integer from 1 to 300000/);
  assert.deepEqual(argv(), []);
  assert.throws(() => createHerdrAdapter({ timeoutMs: timeout }), /timeoutMs must be an integer from 1 to 300000/);
});
