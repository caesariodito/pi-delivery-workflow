import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildChildEnvironment,
  createHerdrAdapter,
  checkCompatibility,
  EXTRACTION_VERDICT,
  HERDR_BASELINE_VERSION,
  HERDR_PROTOCOL,
} from "../extensions/lib/herdr.mjs";

const fixtureDir = fileURLToPath(new URL("./fixtures/herdr/", import.meta.url));
const fake = path.join(fixtureDir, "fake-herdr.mjs");

function harness(extraEnv = {}, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-adapter-"));
  const argvLog = path.join(dir, "argv.jsonl");
  fs.writeFileSync(argvLog, "");
  const adapter = createHerdrAdapter({
    executable: process.execPath,
    executableArgs: [fake],
    env: { HERDR_ARGV_LOG: argvLog, ...extraEnv },
    ...options,
  });
  return { adapter, argv: () => fs.readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) };
}

test("child environment allowlists required context and excludes secrets", () => {
  const env = buildChildEnvironment({ PATH: "/bin", HOME: "/tmp/home", HERDR_SESSION_ID: "session", OPENAI_API_KEY: "secret", RANDOM_REPO_VALUE: "no" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/tmp/home", HERDR_ENV: "1", HERDR_SESSION_ID: "session" });
  assert.equal("OPENAI_API_KEY" in env, false); assert.equal("RANDOM_REPO_VALUE" in env, false);
});

test("pins Herdr baseline and refuses protocol mismatch", async () => {
  assert.equal(HERDR_BASELINE_VERSION, "0.9.5");
  assert.equal(HERDR_PROTOCOL, 22);
  assert.deepEqual(checkCompatibility("0.9.5", 22), { version: "0.9.5", protocol: 22, baseline: true });
  assert.throws(() => checkCompatibility("0.9.5", 23), { code: "protocol_mismatch" });
  assert.throws(() => checkCompatibility("0.9.7", 22), { code: "version_mismatch" });
  assert.throws(() => checkCompatibility("0.10.0", 22), { code: "version_mismatch" });
});

test("refuses versions without verified compatible fixtures and protocol mismatch", async () => {
  assert.throws(() => checkCompatibility("0.9.6", 22), { code: "version_mismatch" });

  const mismatch = harness({ HERDR_STATUS_FIXTURE: "status-protocol-23.json" });
  await assert.rejects(mismatch.adapter.status(), { code: "protocol_mismatch" });
});

test("normalizes version, status, integration, worktree, agent, and notification commands", async () => {
  const { adapter, argv } = harness();
  assert.equal(await adapter.version(), "0.9.5");
  assert.equal((await adapter.status()).server.running, true);
  assert.deepEqual(await adapter.integrationStatus(), [
    { name: "pi", status: "current (v9)", path: "/tmp/pi integration" },
    { name: "codex", status: "not installed", path: "/tmp/codex" },
  ]);
  await adapter.worktreeList({ cwd: "/tmp/repo path" });
  const worktree = await adapter.worktreeCreate({ branch: "ticket;echo unsafe", base: "main", path: "/tmp/work tree", label: "Ticket", focus: false });
  assert.equal(worktree.path, "/tmp/work tree");
  assert.equal(worktree.pane, "w1:p1");
  await adapter.agentStart({ name: "worker", kind: "pi", pane: "w1:p1", agentArgs: ["--model", "name with spaces"] });
  const prompted = await adapter.agentPrompt({ target: "worker", prompt: "-do work; echo unsafe", wait: true, until: ["done", "blocked"], timeout: 1500 });
  assert.equal(prompted.type, "agent_prompted");
  assert.equal((await adapter.agentGet("worker")).type, "ok");
  assert.equal(await adapter.agentRead({ target: "worker" }), "first logical line stays whole despite terminal width\nsecond logical line\n");
  assert.equal((await adapter.agentSendKeys({ target: "worker", keys: ["esc", "ctrl+c"] })).type, "ok");
  assert.equal((await adapter.notify({ title: "Done", body: "Ticket done", sound: "done" })).type, "ok");

  assert.deepEqual(argv().find((entry) => entry[0] === "worktree" && entry[1] === "create"), ["worktree", "create", "--branch", "ticket;echo unsafe", "--base", "main", "--path", "/tmp/work tree", "--label", "Ticket", "--no-focus"]);
  assert.ok(argv().some((entry) => entry.join("\0") === ["agent", "prompt", "worker", "-do work; echo unsafe", "--wait", "--until", "done", "--until", "blocked", "--timeout", "1500"].join("\0")));
  assert.ok(argv().some((entry) => entry.join("\0") === ["agent", "read", "worker", "--source", "recent-unwrapped", "--lines", "120", "--format", "text"].join("\0")));
});

test("wait and prompt preserve activity and blocked semantics", async () => {
  const { adapter, argv } = harness();
  const prompt = await adapter.agentPrompt({ target: "worker", prompt: "task", wait: true, timeout: 2000 });
  assert.equal(prompt.agent.state_change_seq, 13);
  const wait = await adapter.agentWait({ target: "worker", until: ["blocked"], timeout: 2000 });
  assert.equal(wait.event.agent_status, "blocked");
  assert.deepEqual(argv().at(-1), ["agent", "wait", "worker", "--until", "blocked", "--timeout", "2000"]);
  await assert.rejects(adapter.agentPrompt({ target: "worker", prompt: "task", until: ["done"] }), /until requires wait/);
  await assert.rejects(adapter.agentPrompt({ target: "worker", prompt: "task", wait: true, timeout: 300001 }), /1 to 300000/);
  await assert.rejects(adapter.agentWait({ target: "worker", timeout: 300001 }), /1 to 300000/);
});

test("rejects option-shaped identifiers asynchronously", async () => {
  const { adapter, argv } = harness();
  for (const operation of [
    adapter.agentGet("--help"),
    adapter.agentPrompt({ target: "--help", prompt: "task" }),
    adapter.agentStart({ name: "--help", kind: "pi", pane: "w1:p1" }),
    adapter.notify({ title: "--help" }),
  ]) await assert.rejects(operation, /must not start with a hyphen/);
  assert.deepEqual(argv(), []);
});

test("bounds runtime and output and rejects malformed JSON", async () => {
  const delayed = harness({ HERDR_DELAY_MS: "100" }, { timeoutMs: 20 });
  await assert.rejects(delayed.adapter.status(), { code: "timeout" });
  const large = harness({ HERDR_BIG_OUTPUT: "10000" }, { maxOutputBytes: 1024 });
  await assert.rejects(large.adapter.status(), { code: "output_limit" });
  const malformed = harness({ HERDR_MALFORMED: "1" });
  await assert.rejects(malformed.adapter.status(), { code: "malformed_json" });
  const failed = harness({ HERDR_ERROR: "1" });
  await assert.rejects(failed.adapter.agentGet("worker"), { code: "agent_blocked", message: "agent needs input" });
});

test("aborts and forcefully terminates bounded client processes", async () => {
  const controller = new AbortController();
  const aborted = harness({ HERDR_DELAY_MS: "10000" }, { signal: controller.signal, timeoutMs: 300000 });
  const pending = aborted.adapter.status();
  controller.abort();
  await assert.rejects(pending, { code: "aborted" });

  const started = Date.now();
  const timed = harness({ HERDR_DELAY_MS: "10000" }, { timeoutMs: 20 });
  await assert.rejects(timed.adapter.status(), { code: "timeout" });
  assert.ok(Date.now() - started < 2000);
});

test("extraction verdict is result-file-pointer, not terminal-envelope", () => {
  const transcript = fs.readFileSync(path.join(fixtureDir, "agent-read-recent-unwrapped.txt"), "utf8");
  assert.match(transcript, /first logical line stays whole/);
  assert.doesNotMatch(transcript, /<delivery-result>|BEGIN_RESULT|END_RESULT/);
  assert.equal(EXTRACTION_VERDICT, "result-file-pointer");
});
