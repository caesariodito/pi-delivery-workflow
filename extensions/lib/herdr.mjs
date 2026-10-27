import { execFile } from "node:child_process";

export const HERDR_BASELINE_VERSION = "0.9.5";
export const HERDR_PROTOCOL = 22;
export const HERDR_MAX_TIMEOUT_MS = 300_000;
export const EXTRACTION_VERDICT = "result-file-pointer";

// ponytail: 0.9.5/protocol 22 fixtures are synthetic contracts, not live recordings; require live captures before widening versions.
const FIXTURE_PROVEN_VERSIONS = new Set([HERDR_BASELINE_VERSION]);
const DEFAULT_TIMEOUT_MS = 30_000;
const PROCESS_TIMEOUT_GRACE_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const CHILD_ENV_KEYS = Object.freeze(["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "CI", "VOLTA_HOME", "NVM_BIN", "NVM_DIR", "FNM_DIR", "COREPACK_HOME", "HERDR_SESSION", "HERDR_SESSION_ID", "HERDR_SOCKET", "HERDR_SOCKET_PATH"]);
const FIXTURE_ENV_KEYS = new Set(["HERDR_ARGV_LOG", "HERDR_DELAY_MS", "HERDR_BIG_OUTPUT", "HERDR_MALFORMED", "HERDR_ERROR", "HERDR_STATUS_FIXTURE"]);

export function buildChildEnvironment(source = process.env, overrides = {}) {
  const env = {};
  for (const key of CHILD_ENV_KEYS) if (typeof source[key] === "string" && source[key] !== "") env[key] = source[key];
  env.HERDR_ENV = "1";
  for (const [key, value] of Object.entries(overrides)) if ((CHILD_ENV_KEYS.includes(key) || FIXTURE_ENV_KEYS.has(key)) && typeof value === "string" && value !== "") env[key] = value;
  return Object.freeze(env);
}

export class HerdrError extends Error {
  constructor(message, { code = "herdr_error", command = [], exitCode, stderr = "", cause } = {}) {
    super(message, { cause });
    this.name = "HerdrError";
    this.code = code;
    this.command = command;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HerdrError(`${label} must be a JSON object`, { code: "malformed_json" });
  }
  return value;
}

export function parseJsonOutput(stdout, label = "Herdr output") {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    throw new HerdrError(`${label} was not valid JSON`, { code: "malformed_json", cause });
  }
  return object(parsed, label);
}

export function checkCompatibility(version, protocol) {
  if (protocol !== HERDR_PROTOCOL) {
    throw new HerdrError(`Herdr protocol ${protocol} is unsupported; expected ${HERDR_PROTOCOL}`, { code: "protocol_mismatch" });
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new HerdrError(`Herdr version is malformed: ${version}`, { code: "version_mismatch" });
  }
  if (!FIXTURE_PROVEN_VERSIONS.has(version)) {
    throw new HerdrError(`Herdr ${version} is unsupported; no verified compatible fixture`, { code: "version_mismatch" });
  }
  return { version, protocol, baseline: true };
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new TypeError(`${label} must be an integer from 1 to ${maximum}`);
  return value;
}

function text(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new TypeError(`${label} must be a non-empty string without NUL bytes`);
  return value;
}

function identifier(value, label) {
  const valueText = text(value, label);
  if (valueText.startsWith("-")) throw new TypeError(`${label} must not start with a hyphen`);
  return valueText;
}

function unwrap(stdout, command) {
  const envelope = parseJsonOutput(stdout);
  if (envelope.error) {
    const error = object(envelope.error, "Herdr error");
    throw new HerdrError(error.message || "Herdr command failed", { code: error.code || "herdr_error", command });
  }
  if (!("result" in envelope)) throw new HerdrError("Herdr response lacked result", { code: "malformed_json", command });
  return object(envelope.result, "Herdr result");
}

export function createHerdrAdapter({
  executable = "herdr",
  executableArgs = [],
  cwd,
  env,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  text(executable, "executable");
  if (!Array.isArray(executableArgs) || executableArgs.some((arg) => typeof arg !== "string")) throw new TypeError("executableArgs must be an array of strings");
  positiveInteger(timeoutMs, "timeoutMs", HERDR_MAX_TIMEOUT_MS);
  positiveInteger(maxOutputBytes, "maxOutputBytes", 16 * 1024 * 1024);

  function execute(args, { timeout = timeoutMs, json = true } = {}) {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) return Promise.reject(new TypeError("command arguments must be strings"));
    const command = [...executableArgs, ...args];
    return new Promise((resolve, reject) => {
      execFile(executable, command, {
        cwd,
        env: buildChildEnvironment(process.env, env),
        encoding: "utf8",
        maxBuffer: maxOutputBytes,
        timeout,
        killSignal: "SIGKILL",
        signal,
        windowsHide: true,
        shell: false,
      }, (cause, stdout, stderr) => {
        if (cause) {
          let remote;
          try { remote = stderr.trim() ? parseJsonOutput(stderr, "Herdr error output").error : undefined; } catch { /* keep process failure */ }
          const aborted = cause.name === "AbortError" || cause.code === "ABORT_ERR";
          const timedOut = !aborted && (cause.killed || cause.signal === "SIGKILL");
          const tooLarge = cause.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          reject(new HerdrError(
            remote?.message || (aborted ? "Herdr command aborted" : timedOut ? "Herdr command timed out" : tooLarge ? "Herdr output exceeded limit" : `Herdr command failed: ${args.join(" ")}`),
            { code: remote?.code || (aborted ? "aborted" : timedOut ? "timeout" : tooLarge ? "output_limit" : "process_error"), command, exitCode: cause.code, stderr, cause },
          ));
          return;
        }
        try { resolve(json ? unwrap(stdout, command) : stdout); } catch (error) { reject(error); }
      });
    });
  }

  return Object.freeze({
    async version() {
      const stdout = await execute(["--version"], { json: false });
      const match = stdout.trim().match(/^herdr (\d+\.\d+\.\d+)$/);
      if (!match) throw new HerdrError("Herdr version output was malformed", { code: "version_mismatch" });
      return match[1];
    },
    async status() {
      const status = parseJsonOutput(await execute(["status", "--json"], { json: false }), "Herdr status");
      const client = object(status.client, "Herdr client status");
      const server = object(status.server, "Herdr server status");
      const compatibility = checkCompatibility(client.version, client.protocol);
      checkCompatibility(server.version, server.protocol);
      if (server.compatible !== true || server.running !== true) throw new HerdrError("Herdr server is unavailable or incompatible", { code: "server_incompatible" });
      return { client, server, update: status.update ?? null, compatibility };
    },
    async integrationStatus({ outdatedOnly = false } = {}) {
      const stdout = await execute(["integration", "status", ...(outdatedOnly ? ["--outdated-only"] : [])], { json: false });
      return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
        const match = line.match(/^([\w-]+)(?: \(experimental\))?: (current \(v\d+\)|outdated \(v\d+ -> v\d+\)|not installed)(?: \((.*)\))?$/);
        if (!match) throw new HerdrError("Herdr integration status was malformed", { code: "malformed_output" });
        return { name: match[1], status: match[2], path: match[3] ?? null };
      });
    },
    async workspaceList() { return execute(["workspace", "list"]); },
    async worktreeList({ workspace, cwd: worktreeCwd, trustRepository = false } = {}) {
      return execute(["worktree", "list", ...(workspace ? ["--workspace", identifier(workspace, "workspace")] : []), ...(worktreeCwd ? ["--cwd", text(worktreeCwd, "cwd")] : []), ...(trustRepository ? ["--trust-repository"] : [])]);
    },
    async worktreeCreate({ workspace, cwd: worktreeCwd, branch, base, path, label, focus = false, trustRepository = false } = {}) {
      const result = await execute(["worktree", "create", ...(workspace ? ["--workspace", identifier(workspace, "workspace")] : []), ...(worktreeCwd ? ["--cwd", text(worktreeCwd, "cwd")] : []), ...(branch ? ["--branch", text(branch, "branch")] : []), ...(base ? ["--base", text(base, "base")] : []), ...(path ? ["--path", text(path, "path")] : []), ...(label ? ["--label", text(label, "label")] : []), focus ? "--focus" : "--no-focus", ...(trustRepository ? ["--trust-repository"] : [])]);
      return {
        ...result,
        path: result.path ?? result.worktree?.path ?? result.workspace?.worktree?.checkout_path,
        pane: result.pane ?? result.root_pane?.pane_id,
        workspace: result.workspace_id ?? result.workspace?.workspace_id ?? result.workspace?.id,
      };
    },
    async worktreeRemove({ workspace, force = false, trustRepository = false } = {}) {
      return execute(["worktree", "remove", "--workspace", identifier(workspace, "workspace"), ...(force ? ["--force"] : []), ...(trustRepository ? ["--trust-repository"] : [])]);
    },
    async agentStart({ name, kind, pane, timeout = timeoutMs, agentArgs = [] }) {
      if (!Array.isArray(agentArgs) || agentArgs.some((arg) => typeof arg !== "string")) throw new TypeError("agentArgs must be an array of strings");
      const herdrTimeout = positiveInteger(timeout, "timeout", HERDR_MAX_TIMEOUT_MS);
      return execute(["agent", "start", identifier(name, "name"), "--kind", identifier(kind, "kind"), "--pane", identifier(pane, "pane"), "--timeout", String(herdrTimeout), ...(agentArgs.length ? ["--", ...agentArgs] : [])], { timeout: herdrTimeout + PROCESS_TIMEOUT_GRACE_MS });
    },
    async agentPrompt({ target, prompt, wait = false, until = [], timeout = timeoutMs }) {
      if (!Array.isArray(until) || until.some((state) => !["idle", "working", "blocked", "done", "unknown"].includes(state))) throw new TypeError("until contains an invalid agent state");
      if (until.length && !wait) throw new TypeError("until requires wait");
      const herdrTimeout = positiveInteger(timeout, "timeout", HERDR_MAX_TIMEOUT_MS);
      return execute(["agent", "prompt", identifier(target, "target"), text(prompt, "prompt"), ...(wait ? ["--wait"] : []), ...until.flatMap((state) => ["--until", state]), "--timeout", String(herdrTimeout)], { timeout: herdrTimeout + PROCESS_TIMEOUT_GRACE_MS });
    },
    async agentWait({ target, until = [], timeout = timeoutMs }) {
      if (!Array.isArray(until) || until.some((state) => !["idle", "working", "blocked", "done", "unknown"].includes(state))) throw new TypeError("until contains an invalid agent state");
      const herdrTimeout = positiveInteger(timeout, "timeout", HERDR_MAX_TIMEOUT_MS);
      return execute(["agent", "wait", identifier(target, "target"), ...until.flatMap((state) => ["--until", state]), "--timeout", String(herdrTimeout)], { timeout: herdrTimeout + PROCESS_TIMEOUT_GRACE_MS });
    },
    async agentGet(target) { return execute(["agent", "get", identifier(target, "target")]); },
    async agentRead({ target, source = "recent-unwrapped", lines = 120, format = "text" }) {
      if (!["visible", "recent", "recent-unwrapped", "detection"].includes(source)) throw new TypeError("source is invalid");
      if (!["text", "ansi"].includes(format)) throw new TypeError("format is invalid");
      return execute(["agent", "read", identifier(target, "target"), "--source", source, "--lines", String(positiveInteger(lines, "lines")), "--format", format], { json: false });
    },
    async agentSendKeys({ target, keys }) {
      if (!Array.isArray(keys) || keys.length === 0 || keys.some((key) => typeof key !== "string" || !key || key.startsWith("-"))) throw new TypeError("keys must be a non-empty array of non-option strings");
      return execute(["agent", "send-keys", identifier(target, "target"), ...keys]);
    },
    async notify({ title, body, position, sound } = {}) {
      return execute(["notification", "show", identifier(title, "title"), ...(body ? ["--body", text(body, "body")] : []), ...(position ? ["--position", identifier(position, "position")] : []), ...(sound ? ["--sound", identifier(sound, "sound")] : [])]);
    },
  });
}
