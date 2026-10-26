import path from "node:path";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_ID_LENGTH = 128;
const MAX_PATH_LENGTH = 1024;
const MAX_OWNED_PATHS = 256;
const CONTROL_ACTIONS = new Set(["stop", "status", "message"]);

export const LIFECYCLE_TRANSITIONS = Object.freeze(Object.fromEntries(Object.entries({
  ready: ["allocating", "blocked", "stopping"],
  allocating: ["active", "blocked", "stopping"],
  active: ["validating", "blocked", "stopping"],
  validating: ["review", "blocked", "stopping"],
  review: ["done", "needs_fix", "blocked", "stopping"],
  needs_fix: ["active", "blocked", "stopping"],
  stopping: ["stopped", "stop_unconfirmed"],
  done: ["awaiting_integration"],
  awaiting_integration: ["ready", "blocked"],
  stopped: [],
  stop_unconfirmed: [],
  blocked: [],
}).map(([state, next]) => [state, Object.freeze(next)])));

function isCanonicalTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value;
}

function boundedId(value, name) {
  if (typeof value !== "string" || value.length > MAX_ID_LENGTH || !ID_PATTERN.test(value)) {
    throw new TypeError(`${name} must be 1–${MAX_ID_LENGTH} safe characters.`);
  }
  return value;
}

export function validateRunId(value) {
  return boundedId(value, "runId");
}

export function validateTicketId(value) {
  return boundedId(value, "ticketId");
}

export function validateRequestId(value) {
  return boundedId(value, "requestId");
}

export function validateRelativePath(value, options = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`path must contain 1–${MAX_PATH_LENGTH} non-control characters.`);
  }
  if (value.includes("\\") || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new TypeError("path must be a portable relative POSIX path.");
  }
  const directory = value.endsWith("/");
  if (value.includes("//")) throw new TypeError("path must already be normalized.");
  const withoutSuffix = value.replace(/\/$/, "");
  const normalized = path.posix.normalize(withoutSuffix);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.split("/").includes("..")) {
    throw new TypeError("path must not be empty or traverse outside its root.");
  }
  if (normalized !== withoutSuffix) throw new TypeError("path must already be normalized.");
  if (options.allowDirectoryPrefix === false && directory) throw new TypeError("path must name an exact path, not a directory prefix.");
  return directory ? `${normalized}/` : normalized;
}

function ownershipEntry(value) {
  const normalized = validateRelativePath(value);
  if (/[*?{}[\]!]/.test(normalized)) throw new TypeError("ownership path must be exact or a trailing-slash directory prefix.");
  return Object.freeze({ path: normalized.replace(/\/$/, ""), directory: normalized.endsWith("/") });
}

export function validateOwnedPaths(value) {
  if (!Array.isArray(value) || value.length > MAX_OWNED_PATHS) throw new TypeError(`ownedPaths must be an array of at most ${MAX_OWNED_PATHS} paths.`);
  const entries = value.map(ownershipEntry);
  const keys = new Set();
  for (const entry of entries) {
    const key = `${entry.path}${entry.directory ? "/" : ""}`;
    if (keys.has(key)) throw new TypeError(`duplicate ownership path: ${key}`);
    keys.add(key);
  }
  return entries;
}

export function validateOwnershipPath(value) {
  if (typeof value === "string") return ownershipEntry(value);
  if (!value || typeof value !== "object" || typeof value.path !== "string" || typeof value.directory !== "boolean") {
    throw new TypeError("ownership entry is undecidable; use an exact path or trailing-slash directory prefix.");
  }
  const checked = ownershipEntry(`${value.path}${value.directory ? "/" : ""}`);
  if (checked.path !== value.path) throw new TypeError("ownership entry must be normalized.");
  return checked;
}

export function pathsOverlap(left, right) {
  const a = validateOwnershipPath(left);
  const b = validateOwnershipPath(right);
  if (a.path === b.path) return true;
  if (a.directory && b.path.startsWith(`${a.path}/`)) return true;
  if (b.directory && a.path.startsWith(`${b.path}/`)) return true;
  return false;
}

export function validateLifecycleTransition(from, to) {
  if (typeof from !== "string" || !(from in LIFECYCLE_TRANSITIONS)) throw new TypeError(`unknown lifecycle state: ${String(from)}`);
  if (typeof to !== "string" || !(to in LIFECYCLE_TRANSITIONS)) throw new TypeError(`unknown lifecycle state: ${String(to)}`);
  if (!LIFECYCLE_TRANSITIONS[from].includes(to)) throw new Error(`invalid lifecycle transition: ${from} to ${to}`);
  return to;
}

export function validateCommandSpec(value) {
  const allowed = ["executable", "args", "cwd"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError("command must contain only executable, args, and optional cwd.");
  }
  if (typeof value.executable !== "string" || !value.executable || value.executable.length > 1024 || /[\u0000\r\n]/.test(value.executable)) {
    throw new TypeError("command executable must be bounded text.");
  }
  if (!Array.isArray(value.args) || value.args.length > 256 || value.args.some((arg) => typeof arg !== "string" || arg.length > 8192 || arg.includes("\0"))) {
    throw new TypeError("command args must contain at most 256 bounded strings.");
  }
  const command = { executable: value.executable, args: [...value.args] };
  if (value.cwd !== undefined) command.cwd = validateRelativePath(value.cwd, { allowDirectoryPrefix: false });
  return Object.freeze(command);
}

export function validateControlRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["version", "requestId", "runId", "action", "message", "createdAt"].includes(key))) {
    throw new TypeError("control request contains unsupported fields.");
  }
  if (value.version !== 1) throw new TypeError("control request version must be 1.");
  const requestId = validateRequestId(value.requestId);
  const runId = validateRunId(value.runId);
  if (!CONTROL_ACTIONS.has(value.action)) throw new TypeError("control request action must be stop, status, or message.");
  if (value.message !== undefined && (typeof value.message !== "string" || !value.message.trim() || value.message.length > 16_000 || value.message.includes("\0"))) throw new TypeError("control request message must be bounded text.");
  if (value.action === "message" && value.message === undefined) throw new TypeError("message action requires message text.");
  if (!isCanonicalTimestamp(value.createdAt)) throw new TypeError("control request createdAt must be a canonical ISO timestamp.");
  return Object.freeze({ version: 1, requestId, runId, action: value.action, ...(value.message === undefined ? {} : { message: value.message }), createdAt: value.createdAt });
}
