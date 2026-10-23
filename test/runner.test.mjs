import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDeliveryRunner, createProcessRunner, RESULT_PROTOCOL, REVIEW_TOOLS, validateTicketRunContract } from "../extensions/lib/runner.mjs";

const fixture = fileURLToPath(new URL("./fixtures/git/base.txt", import.meta.url));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-runner-"));
  git(root, "init", "-b", "ticket/T003");
  git(root, "config", "user.name", "Runner Test");
  git(root, "config", "user.email", "runner@example.invalid");
  fs.mkdirSync(path.join(root, "src"));
  fs.copyFileSync(fixture, path.join(root, "src/value.txt"));
  git(root, "add", "src/value.txt");
  git(root, "commit", "-m", "fixture base");
  return root;
}

function contract(root, overrides = {}) {
  return {
    version: 1,
    runId: "run-1",
    ticketId: "T003",
    planApproved: true,
    repositoryPath: root,
    worktreePath: root,
    baseSha: git(root, "rev-parse", "HEAD"),
    branch: "ticket/T003",
    ticket: "Change src/value.txt and prove it.",
    context: "Approved plan context.",
    ownedPaths: ["src/value.txt"],
    forbiddenPaths: ["package.json"],
    validation: { executable: process.execPath, args: ["-e", "process.exit(0)"] },
    maxFixRounds: 2,
    worker: { name: "worker", kind: "pi", pane: "w:p1", model: "worker-model", session: "worker-session" },
    reviewer: { name: "reviewer", kind: "pi", pane: "w:p2", model: "reviewer-model", session: "reviewer-session" },
    artifactMappings: {},
    ...overrides,
  };
}

function pointer(prompt) {
  const match = prompt.match(/Read prompt file (.*) \(SHA-256 [0-9a-f]{64}\)/);
  assert.ok(match);
  return match[1];
}

function resultPath(promptFile) {
  const content = fs.readFileSync(promptFile, "utf8");
  const match = content.match(/Write JSON result to ([^\n]+) with mode 0600/) ?? content.match(/scoped tool writes only ([^\n]+) with mode 0600/);
  assert.ok(match);
  return { content, path: match[1] };
}

function writeResult(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function writeRecoveryState(directory, state) {
  const promptPath = path.join(directory, "recovery.prompt");
  const prompt = "exact persisted prompt\n";
  fs.writeFileSync(promptPath, prompt, { mode: 0o600 });
  fs.writeFileSync(path.join(directory, "state.json"), `${JSON.stringify({ ...state, promptPath, promptSha256: createHash("sha256").update(prompt).digest("hex") })}\n`, { mode: 0o600 });
}

function fakeHerdr(root, verdicts = ["ok"], options = {}) {
  const calls = [];
  let reviews = 0;
  let workers = 0;
  const adapter = {
    extractionVerdict: RESULT_PROTOCOL,
    async status() { calls.push(["status"]); return { server: { running: true } }; },
    async worktreeCreate(input) { calls.push(["worktreeCreate", input]); return { path: root, pane: "w:p1" }; },
    async agentStart(input) { calls.push(["agentStart", input]); return {}; },
    async agentPrompt(input) {
      calls.push(["agentPrompt", input]);
      const promptFile = pointer(input.prompt);
      const result = resultPath(promptFile);
      assert.equal(fs.statSync(promptFile).mode & 0o777, 0o600);
      if (result.content.startsWith("Immutable approved ticket")) {
        workers += 1;
        fs.writeFileSync(path.join(root, "src/value.txt"), `worker ${workers}\n`);
        writeResult(result.path, { version: 1, status: "done", summary: `worker ${workers}` });
      } else {
        const candidateHash = result.content.match(/Frozen candidate SHA-256: ([0-9a-f]{64})/)[1];
        const verdict = verdicts[reviews++] ?? "ok";
        writeResult(result.path, { version: 1, verdict, findings: verdict === "needs_fix" ? [{ severity: "P1", location: "src/value.txt:1", problem: "first pass", action: "revise" }] : [], summary: verdict, candidateHash });
        if (options.driftDuringReview) fs.appendFileSync(path.join(root, "src/value.txt"), "review mutation\n");
      }
      return { agent: { status: "done" } };
    },
    async agentGet() { return { agent: { status: "done" } }; },
  };
  return { adapter, calls, counts: () => ({ reviews, workers }) };
}

function randomSequence() {
  let value = 0;
  return () => `nonce${++value}`;
}

function instrumentedProcessRunner() {
  const calls = [];
  return {
    calls,
    async run(spec) {
      calls.push(spec);
      try {
        const output = execFileSync(spec.executable, spec.args, { cwd: spec.cwd, encoding: null, shell: false });
        return { code: 0, stdout: output, stderr: Buffer.alloc(0) };
      } catch (error) {
        return { code: error.status, stdout: error.stdout ?? Buffer.alloc(0), stderr: error.stderr ?? Buffer.alloc(0) };
      }
    },
  };
}

test("validates and deeply freezes approved serial contract", () => {
  const root = repository();
  const checked = validateTicketRunContract(contract(root));
  assert.ok(Object.isFrozen(checked));
  assert.ok(Object.isFrozen(checked.worker));
  assert.throws(() => validateTicketRunContract(contract(root, { planApproved: false })), /plan approval/);
  assert.throws(() => validateTicketRunContract(contract(root, { maxFixRounds: 3 })), /0 through 2/);
  assert.throws(() => validateTicketRunContract(contract(root, { agentTimeoutMs: 300_001 })), /1 through 300000/);
  assert.equal(validateTicketRunContract(contract(root, { agentTimeoutMs: 45_000 })).agentTimeoutMs, 45_000);
  assert.throws(() => validateTicketRunContract({ ...contract(root), extra: true }), /unsupported fields/);
});

test("requires Git evidence, passing gate, fresh review, stable hash, and manifest before done", async () => {
  const root = repository();
  const herdr = fakeHerdr(root);
  const processRunner = instrumentedProcessRunner();
  const notices = [];
  const runner = createDeliveryRunner({ herdr: herdr.adapter, processRunner, clock: () => new Date("2026-01-01T00:00:00.000Z"), random: randomSequence(), notifier: async (notice) => notices.push(notice) });
  const result = await runner.runTicket(contract(root));
  assert.equal(result.status, "done");
  assert.deepEqual(result.manifest.changedPaths, ["src/value.txt"]);
  assert.equal(result.manifest.baseSha, contract(root).baseSha);
  assert.match(result.manifest.patchSha256, /^[0-9a-f]{64}$/);
  assert.ok(fs.existsSync(result.manifestPath));
  assert.equal(notices.length, 1);
  assert.ok(processRunner.calls.some((call) => call.executable === process.execPath));
  assert.ok(processRunner.calls.filter((call) => call.executable === "git").every((call) => Array.isArray(call.args)));
  const worker = herdr.calls.find(([name, value]) => name === "agentStart" && value.name.startsWith("worker-"));
  assert.equal(worker[1].agentArgs.includes("--extension"), false);
  const reviewer = herdr.calls.find(([name, value]) => name === "agentStart" && value.name.startsWith("reviewer-"));
  assert.deepEqual(reviewer[1].agentArgs.slice(0, 2), ["--model", "reviewer-model"]);
  assert.match(reviewer[1].agentArgs[3], /reviewer-result-tool\.ts$/);
  assert.equal(reviewer[1].agentArgs.at(-1), "read,grep,find,ls,delivery_result_write");
  assert.equal(reviewer[1].agentArgs.at(-1).includes("write"), true);
  assert.equal(reviewer[1].agentArgs.at(-1).includes("edit"), false);
  assert.equal(reviewer[1].agentArgs.at(-1).includes("bash"), false);
  assert.equal(reviewer[1].timeout, 300_000);
  assert.ok(herdr.calls.filter(([name]) => name === "agentPrompt").every(([, value]) => value.timeout === 300_000 && value.wait === true));
  assert.deepEqual(REVIEW_TOOLS, ["read", "grep", "find", "ls"]);
});

test("each accepted fix reruns gate and launches a fresh reviewer", async () => {
  const root = repository();
  const herdr = fakeHerdr(root, ["needs_fix", "needs_fix", "ok"]);
  const processRunner = instrumentedProcessRunner();
  const result = await createDeliveryRunner({ herdr: herdr.adapter, processRunner, random: randomSequence() }).runTicket(contract(root));
  assert.equal(result.status, "done");
  assert.deepEqual(herdr.counts(), { workers: 3, reviews: 3 });
  assert.equal(new Set(herdr.calls.filter(([name, value]) => name === "agentStart" && value.name.startsWith("reviewer-")).map(([, value]) => value.name)).size, 3);
  assert.equal(processRunner.calls.filter((call) => call.executable === process.execPath).length, 3);
});

test("fails closed on ownership, gate, review drift, fix limit, and protocol mismatch", async () => {
  {
    const root = repository();
    const herdr = fakeHerdr(root);
    const bad = contract(root, { ownedPaths: ["test/"] });
    await assert.rejects(createDeliveryRunner({ herdr: herdr.adapter }).runTicket(bad), /ownership violation/);
  }
  {
    const root = repository();
    const herdr = fakeHerdr(root);
    const originalPrompt = herdr.adapter.agentPrompt;
    herdr.adapter.agentPrompt = async (input) => {
      const result = await originalPrompt(input);
      if (resultPath(pointer(input.prompt)).content.startsWith("Immutable approved ticket")) fs.writeFileSync(path.join(root, "package.json"), "{}\n");
      return result;
    };
    await assert.rejects(createDeliveryRunner({ herdr: herdr.adapter }).runTicket(contract(root)), /ownership violation/);
  }
  {
    const root = repository();
    const herdr = fakeHerdr(root);
    const badGate = contract(root, { validation: { executable: process.execPath, args: ["-e", "process.exit(7)"] } });
    const result = await createDeliveryRunner({ herdr: herdr.adapter }).runTicket(badGate);
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "validation failed");
    assert.equal(herdr.counts().reviews, 0);
  }
  {
    const root = repository();
    const herdr = fakeHerdr(root, ["ok"], { driftDuringReview: true });
    const result = await createDeliveryRunner({ herdr: herdr.adapter }).runTicket(contract(root));
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "candidate drifted during review");
  }
  {
    const root = repository();
    const herdr = fakeHerdr(root, ["needs_fix"]);
    const result = await createDeliveryRunner({ herdr: herdr.adapter }).runTicket(contract(root, { maxFixRounds: 0 }));
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "fix-round limit reached");
  }
  {
    const root = repository();
    const herdr = fakeHerdr(root);
    herdr.adapter.extractionVerdict = "terminal-envelope";
    await assert.rejects(createDeliveryRunner({ herdr: herdr.adapter }).runTicket(contract(root)), /unsupported Herdr extraction protocol/);
    assert.deepEqual(herdr.calls, []);
  }
});

test("serial recovery harvests exact settled pointer and never prompts on ambiguity", async () => {
  const root = repository();
  const input = contract(root);
  const runDirectory = path.join(root, ".scratch/delivery/run-1/T003");
  fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  const resultFile = path.join(runDirectory, "worker-result.json");
  writeResult(resultFile, { version: 1, status: "done", summary: "settled" });
  writeRecoveryState(runDirectory, { version: 1, runId: "run-1", ticketId: "T003", phase: "worker_waiting", target: "worker-run-1", resultPath: resultFile });
  const herdr = fakeHerdr(root);
  const runner = createDeliveryRunner({ herdr: herdr.adapter });
  const recovered = await runner.recoverSettledResult(input, { expectedTarget: "worker-run-1", expectedKind: "worker" });
  assert.equal(recovered.status, "recovered");
  assert.equal(recovered.result.summary, "settled");
  assert.equal(herdr.calls.filter(([name]) => name === "agentPrompt").length, 0);
  const secondRoot = repository();
  const secondInput = contract(secondRoot);
  const secondDirectory = path.join(secondRoot, ".scratch/delivery/run-1/T003");
  fs.mkdirSync(secondDirectory, { recursive: true, mode: 0o700 });
  const secondResult = path.join(secondDirectory, "worker-result.json");
  writeResult(secondResult, { version: 1, status: "done", summary: "settled" });
  writeRecoveryState(secondDirectory, { version: 1, runId: "run-1", ticketId: "T003", phase: "worker_waiting", target: "worker-run-1", resultPath: secondResult });
  const ambiguous = await createDeliveryRunner({ herdr: fakeHerdr(secondRoot).adapter }).recoverSettledResult(secondInput, { expectedTarget: "other" });
  assert.equal(ambiguous.status, "blocked");
  assert.match(ambiguous.reason, /ambiguous/);
  assert.equal(herdr.calls.filter(([name]) => name === "agentPrompt").length, 0);
});

test("process runner bounds timeout and output with SIGKILL results", async () => {
  const timeout = await createProcessRunner({ timeoutMs: 20 }).run({ executable: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"] });
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.signal, "SIGKILL");
  const output = await createProcessRunner({ maxOutputBytes: 32 }).run({ executable: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(10000)); setTimeout(() => {}, 10000)"] });
  assert.equal(output.outputLimit, true);
  assert.equal(output.signal, "SIGKILL");
});

test("process timeout kills subprocess group and settles despite grandchild-held pipes", { skip: process.platform === "win32" }, async () => {
  const started = Date.now();
  const script = "require('node:child_process').spawn(process.execPath,['-e','setInterval(() => {}, 10000)'],{stdio:['ignore','inherit','inherit']});";
  const result = await createProcessRunner({ timeoutMs: 40 }).run({ executable: process.execPath, args: ["-e", script] });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
  assert.ok(Date.now() - started < 1000);
});

test("validation mutation blocks candidate before reviewer launch", async () => {
  const root = repository();
  const herdr = fakeHerdr(root);
  const input = contract(root, { validation: { executable: process.execPath, args: ["-e", "require('node:fs').writeFileSync('src/value.txt', 'gate mutation\\n')"] } });
  const result = await createDeliveryRunner({ herdr: herdr.adapter, random: randomSequence() }).runTicket(input);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "candidate drifted during validation");
  assert.equal(herdr.counts().reviews, 0);
  assert.equal(herdr.calls.filter(([name, value]) => name === "agentStart" && value.name.startsWith("reviewer-")).length, 0);
  const state = JSON.parse(fs.readFileSync(path.join(root, ".scratch/delivery/run-1/T003/state.json"), "utf8"));
  assert.equal(state.phase, "blocked");
  assert.equal(state.reason, "candidate drifted during validation");
});

test("setup identity, prompts, artifacts, and reviewer nonce bind approved candidate", async () => {
  const root = repository();
  const herdr = fakeHerdr(root);
  const runner = createDeliveryRunner({ herdr: herdr.adapter, random: randomSequence() });
  const result = await runner.runTicket(contract(root));
  assert.equal(result.status, "done");
  const prompts = herdr.calls.filter(([name]) => name === "agentPrompt").map(([, input]) => fs.readFileSync(pointer(input.prompt), "utf8"));
  assert.ok(prompts.every((prompt) => prompt.includes(`Approved worktree: ${root}`) && prompt.includes(`Approved base: ${contract(root).baseSha}`)));
  assert.match(prompts[1], /Frozen patch: .*candidate-0\.patch/);
  assert.match(prompts[1], /Frozen patch SHA-256: [0-9a-f]{64}/);
  assert.match(prompts[1], /Passing validation log: .*validation-0\.log/);
  for (const file of [result.manifest.patchPath, result.manifest.validationLog].map((relative) => path.join(root, relative))) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const starts = herdr.calls.filter(([name]) => name === "agentStart").map(([, input]) => input.name);
  assert.notEqual(starts[0], starts[1]);

  const mismatchRoot = repository();
  const mismatch = fakeHerdr(mismatchRoot);
  mismatch.adapter.worktreeCreate = async () => ({ path: mismatchRoot, pane: "wrong" });
  await assert.rejects(createDeliveryRunner({ herdr: mismatch.adapter }).runTicket(contract(mismatchRoot)), /path or pane/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(mismatchRoot, ".scratch/delivery/run-1/T003/state.json"), "utf8")).phase, "blocked");
});

test("review result schema and pre-existing files fail closed with final blocked state", async () => {
  for (const reviewValue of [
    { version: 1, verdict: "ok", findings: [{ severity: "P1", location: "x", problem: "bad", action: "fix" }], summary: "bad", candidateHash: null },
    { version: 1, verdict: "needs_fix", findings: [], summary: "bad", candidateHash: null },
  ]) {
    const root = repository();
    const herdr = fakeHerdr(root);
    const original = herdr.adapter.agentPrompt;
    herdr.adapter.agentPrompt = async (input) => {
      const promptFile = pointer(input.prompt);
      const result = resultPath(promptFile);
      if (result.content.startsWith("Immutable approved ticket")) return original(input);
      const hash = result.content.match(/Frozen candidate SHA-256: ([0-9a-f]{64})/)[1];
      writeResult(result.path, { ...reviewValue, candidateHash: hash });
      return { agent: { status: "done" } };
    };
    await assert.rejects(createDeliveryRunner({ herdr: herdr.adapter, random: randomSequence() }).runTicket(contract(root)), /ok review must not|needs_fix review requires/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".scratch/delivery/run-1/T003/state.json"), "utf8")).phase, "blocked");
  }

  const root = repository();
  const herdr = fakeHerdr(root);
  let randomCalls = 0;
  const preexistingRandom = () => {
    randomCalls += 1;
    if (randomCalls === 2) {
      const file = path.join(root, ".scratch/delivery/run-1/T003/review-0-reviewnonce.json");
      writeResult(file, { version: 1, verdict: "ok", findings: [], summary: "preexisting", candidateHash: "0".repeat(64) });
      return "reviewnonce";
    }
    return "workernonce";
  };
  await assert.rejects(createDeliveryRunner({ herdr: herdr.adapter, random: preexistingRandom }).runTicket(contract(root)), /already exists/);
});

test("result symlinks and loose permissions fail closed; untracked owned file enters patch", async () => {
  for (const mode of ["symlink", "permissions"]) {
    const root = repository();
    const herdr = fakeHerdr(root);
    herdr.adapter.agentPrompt = async (input) => {
      const result = resultPath(pointer(input.prompt));
      fs.writeFileSync(path.join(root, "src/value.txt"), "changed\n");
      if (mode === "symlink") {
        const target = path.join(path.dirname(result.path), "target.json");
        writeResult(target, { version: 1, status: "done", summary: "x" });
        fs.symlinkSync(target, result.path);
      } else {
        writeResult(result.path, { version: 1, status: "done", summary: "x" });
        fs.chmodSync(result.path, 0o644);
      }
      return { agent: { status: "done" } };
    };
    await assert.rejects(createDeliveryRunner({ herdr: herdr.adapter, random: randomSequence() }).runTicket(contract(root)), /worker result is missing or invalid/);
  }

  const root = repository();
  const herdr = fakeHerdr(root);
  const input = contract(root, { ownedPaths: ["src/value.txt", "src/new.txt"] });
  const original = herdr.adapter.agentPrompt;
  herdr.adapter.agentPrompt = async (call) => {
    const result = await original(call);
    if (resultPath(pointer(call.prompt)).content.startsWith("Immutable approved ticket")) fs.writeFileSync(path.join(root, "src/new.txt"), "untracked\n");
    return result;
  };
  const done = await createDeliveryRunner({ herdr: herdr.adapter, random: randomSequence() }).runTicket(input);
  assert.deepEqual(done.manifest.changedPaths, ["src/new.txt", "src/value.txt"]);
  assert.match(fs.readFileSync(path.join(root, done.manifest.patchPath), "utf8"), /src\/new\.txt/);
});

test("recovery validates identity and candidate hash, then consumes waiting state", async () => {
  const root = repository();
  const input = contract(root);
  const directory = path.join(root, ".scratch/delivery/run-1/T003");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const review = path.join(directory, "review.json");
  const hash = "a".repeat(64);
  writeResult(review, { version: 1, verdict: "ok", findings: [], summary: "ok", candidateHash: hash });
  writeRecoveryState(directory, { version: 1, runId: "run-1", ticketId: "T003", phase: "review_waiting", target: "reviewer", resultPath: review, candidateHash: hash });
  const runner = createDeliveryRunner({ herdr: fakeHerdr(root).adapter });
  const recovered = await runner.recoverSettledResult(input, { expectedTarget: "reviewer", expectedKind: "review", expectedCandidateHash: hash });
  assert.equal(recovered.status, "recovered");
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "state.json"), "utf8")).phase, "recovered");
  const replay = await runner.recoverSettledResult(input, { expectedTarget: "reviewer" });
  assert.equal(replay.status, "blocked");
  assert.match(replay.reason, /ambiguous/);
});
