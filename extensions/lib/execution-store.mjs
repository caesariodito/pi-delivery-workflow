import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes, createHash } from "node:crypto";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function read(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024) throw new Error("invalid execution record");
    const bytes = Buffer.alloc(256 * 1024 + 1); let length = 0;
    while (length < bytes.length) { const count = fs.readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count; }
    if (length > 256 * 1024) throw new Error("execution record exceeds limit");
    return JSON.parse(bytes.subarray(0, length).toString("utf8"));
  } finally { fs.closeSync(fd); }
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function exclusive(file, value) {
  const body = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(body) > 256 * 1024) throw new Error("execution record exceeds limit");
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try { fs.writeFileSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}
function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

// ponytail: local attached controller only; never steal locks or infer external operation success from a missing outcome.
export function openExecutionStore(directory) {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || fs.realpathSync(directory) !== directory) throw new Error("execution store requires canonical existing directory");
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())))) throw new Error("execution store must be private and owned by current user");
  const lockPath = path.join(directory, "controller.lock"); let token;
  function assertLock() { if (!token || read(lockPath).token !== token) throw new Error("execution controller lock is not held"); }
  function recordPath(id, suffix) { if (typeof id !== "string" || !ID.test(id)) throw new TypeError("operation ID is invalid"); return path.join(directory, `${id}.${suffix}.json`); }
  return {
    acquire() {
      if (token) throw new Error("controller already holds lock");
      const next = randomBytes(24).toString("hex");
      exclusive(lockPath, { version: 1, pid: process.pid, host: os.hostname(), token: next, createdAt: new Date().toISOString() }); token = next;
    },
    release() { assertLock(); fs.unlinkSync(lockPath); syncDirectory(directory); token = undefined; },
    lockInfo() { return fs.existsSync(lockPath) ? read(lockPath) : null; },
    // Recovery of stale locks intentionally requires explicit external inspection; PID age/reuse is not ownership proof.
    begin(id, intent) {
      assertLock(); const file = recordPath(id, "intent");
      exclusive(file, { version: 1, operationId: id, intent }); return digest(read(file));
    },
    settle(id, outcome) {
      assertLock(); const intent = read(recordPath(id, "intent"));
      if (intent.version !== 1 || intent.operationId !== id) throw new Error("operation intent identity mismatch");
      exclusive(recordPath(id, "outcome"), { version: 1, operationId: id, intentDigest: digest(intent), outcome });
    },
    inspect(id) {
      const intentFile = recordPath(id, "intent"); const outcomeFile = recordPath(id, "outcome");
      const intent = read(intentFile);
      if (intent.version !== 1 || intent.operationId !== id) throw new Error("operation intent identity mismatch");
      if (!fs.existsSync(outcomeFile)) return { status: "recovery_unknown", intent, outcome: null, replayAllowed: false };
      const outcome = read(outcomeFile);
      if (outcome.version !== 1 || outcome.operationId !== id || outcome.intentDigest !== digest(intent)) throw new Error("operation outcome evidence mismatch");
      return { status: "recorded", intent, outcome, replayAllowed: false };
    },
    saveState(state) {
      assertLock(); const temp = path.join(directory, `state-${randomBytes(12).toString("hex")}.tmp`);
      exclusive(temp, state); fs.renameSync(temp, path.join(directory, "state.json")); syncDirectory(directory);
    },
    operations() {
      const names = fs.readdirSync(directory); const ids = new Set();
      for (const name of names) {
        const match = name.match(/^(operation-[1-9][0-9]*)\.(intent|outcome)\.json$/);
        if (match) ids.add(match[1]);
        else if (name.startsWith("operation-")) throw new Error("invalid operation evidence filename");
      }
      return [...ids].sort((a, b) => Number(a.slice(10)) - Number(b.slice(10)));
    },
    state() { return read(path.join(directory, "state.json")); },
  };
}
