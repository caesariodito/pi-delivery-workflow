import fs from "node:fs";
import path from "node:path";
import { validateControlRequest, validateRequestId, validateRunId } from "./contracts.mjs";

const MAX_JSON_BYTES = 1024 * 1024;

function json(value) {
  let encoded;
  try {
    encoded = JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint" || typeof item === "function" || typeof item === "symbol" || item === undefined || (typeof item === "number" && !Number.isFinite(item))) {
        throw new TypeError("value must contain only JSON-serializable data.");
      }
      return item;
    });
  } catch (error) {
    if (error instanceof TypeError && error.message === "value must contain only JSON-serializable data.") throw error;
    throw new TypeError("value must contain only JSON-serializable data.", { cause: error });
  }
  if (typeof encoded !== "string") throw new TypeError("value must contain only JSON-serializable data.");
  const text = `${encoded}\n`;
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new TypeError(`JSON value exceeds ${MAX_JSON_BYTES} bytes.`);
  return text;
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

function syncFile(fd) {
  try { fs.fsyncSync(fd); } catch { /* Best effort on filesystems without fsync support. */ }
}

export function atomicWriteJson(filePath, value) {
  ensureParent(filePath);
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, json(value), "utf8");
    syncFile(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filePath);
    try {
      const directory = fs.openSync(path.dirname(filePath), "r");
      syncFile(directory);
      fs.closeSync(directory);
    } catch { /* Best effort directory durability. */ }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return value;
}

export function appendJsonLine(filePath, value) {
  ensureParent(filePath);
  const fd = fs.openSync(filePath, "a", 0o600);
  try {
    fs.writeFileSync(fd, json(value), "utf8");
    syncFile(fd);
  } finally {
    fs.closeSync(fd);
  }
  return value;
}

export function readJson(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > MAX_JSON_BYTES) throw new Error(`JSON file must be a regular file no larger than ${MAX_JSON_BYTES} bytes.`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function lockRecord(owner) {
  const created = typeof owner?.createdAt === "string" ? new Date(owner.createdAt) : undefined;
  const validCreatedAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(owner?.createdAt ?? "") && Number.isFinite(created?.valueOf()) && created.toISOString() === owner.createdAt;
  if (!owner || typeof owner !== "object" || owner.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.processStart !== "string" || !owner.processStart || owner.processStart.length > 256 || !validCreatedAt) {
    throw new TypeError("lock owner requires version 1, positive pid, processStart, runId, and createdAt.");
  }
  return { version: 1, pid: owner.pid, processStart: owner.processStart, runId: validateRunId(owner.runId), createdAt: owner.createdAt };
}

export function acquireRunnerLock(lockPath, owner, options = {}) {
  const record = lockRecord(owner);
  ensureParent(lockPath);
  const create = () => exclusiveJson(lockPath, record);
  try {
    return create();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  if (typeof options.isOwnerAlive !== "function") throw new Error("runner lock exists and owner liveness is unknown.");
  // Exclusive takeover claim serializes stale replacement attempts.
  const claim = `${lockPath}.takeover`;
  let claimFd;
  try {
    claimFd = fs.openSync(claim, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("runner lock takeover is already in progress.");
    throw error;
  }
  try {
    let existing;
    try { existing = lockRecord(readJson(lockPath)); } catch { throw new Error("runner lock exists but owner evidence is unreadable."); }
    let alive;
    try { alive = options.isOwnerAlive(Object.freeze(existing)); } catch { throw new Error("runner lock exists and owner liveness check failed."); }
    if (alive !== false) throw new Error("runner lock exists and owner is alive or unknown.");
    const stale = `${lockPath}.stale-${process.pid}-${Date.now()}`;
    fs.renameSync(lockPath, stale);
    return create();
  } finally {
    fs.closeSync(claimFd);
    fs.unlinkSync(claim);
  }
}

export function releaseRunnerLock(lockPath, owner) {
  const expected = lockRecord(owner);
  const current = lockRecord(readJson(lockPath));
  if (current.pid !== expected.pid || current.processStart !== expected.processStart || current.runId !== expected.runId) throw new Error("runner lock ownership does not match.");
  fs.unlinkSync(lockPath);
}

function exclusiveJson(filePath, value) {
  ensureParent(filePath);
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, json(value), "utf8");
    syncFile(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(temporary, filePath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return value;
}

export function writeInboxRequest(inboxPath, request) {
  const checked = validateControlRequest(request);
  return exclusiveJson(path.join(inboxPath, `${checked.requestId}.json`), checked);
}

export function writeReceipt(receiptsPath, receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || typeof receipt.requestId !== "string") throw new TypeError("receipt requires requestId.");
  const requestId = validateRequestId(receipt.requestId);
  return exclusiveJson(path.join(receiptsPath, `${requestId}.json`), receipt);
}
