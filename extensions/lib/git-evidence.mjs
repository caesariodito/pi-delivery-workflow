import crypto from "node:crypto";
import { validateOwnedPaths, validateOwnershipPath, validateRelativePath, validateTicketId } from "./contracts.mjs";

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_CHANGED_PATHS = 4096;

export function sha256(value) {
  if (typeof value !== "string" && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw new TypeError("sha256 input must be text or bytes.");
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function parsePorcelainV1Z(output) {
  if (typeof output !== "string" && !Buffer.isBuffer(output)) throw new TypeError("porcelain output must be text or bytes.");
  const fields = Buffer.isBuffer(output) ? output.toString("utf8").split("\0") : output.split("\0");
  if (fields.at(-1) !== "") throw new Error("porcelain -z output must end with NUL.");
  fields.pop();
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length < 4 || field[2] !== " ") throw new Error("invalid porcelain v1 -z entry.");
    const status = field.slice(0, 2);
    const path = validateRelativePath(field.slice(3), { allowDirectoryPrefix: false });
    const renamed = status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C";
    let originalPath;
    if (renamed) {
      if (++index >= fields.length) throw new Error("renamed porcelain entry lacks original path.");
      originalPath = validateRelativePath(fields[index], { allowDirectoryPrefix: false });
    }
    entries.push(Object.freeze({ status, path, ...(originalPath ? { originalPath } : {}) }));
  }
  return entries;
}

export function normalizeOwnership(paths) {
  return validateOwnedPaths(paths);
}

export function findOwnershipViolations(changedPaths, ownership) {
  if (!Array.isArray(changedPaths) || changedPaths.length > MAX_CHANGED_PATHS) throw new TypeError(`changedPaths must contain at most ${MAX_CHANGED_PATHS} paths.`);
  if (!Array.isArray(ownership) || ownership.length > 256) throw new TypeError("ownership must contain at most 256 paths.");
  const owned = ownership.map(validateOwnershipPath);
  return changedPaths.map((value) => validateRelativePath(value, { allowDirectoryPrefix: false })).filter((changed) => !owned.some((entry) => changed === entry.path || (entry.directory && changed.startsWith(`${entry.path}/`))));
}

function boundedString(value, name, max = 4096) {
  if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`${name} must be bounded text.`);
  return value;
}

function sha(value, name) {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) throw new TypeError(`${name} must be a lowercase Git object ID.`);
  return value;
}

function plainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${name} must be a plain object.`);
  return value;
}

export function createHandoffManifest(input) {
  plainObject(input, "manifest input");
  const changedPaths = input.changedPaths;
  if (!Array.isArray(changedPaths) || changedPaths.length > MAX_CHANGED_PATHS) throw new TypeError(`changedPaths must contain at most ${MAX_CHANGED_PATHS} paths.`);
  const normalizedPaths = changedPaths.map((value) => validateRelativePath(value, { allowDirectoryPrefix: false }));
  if (new Set(normalizedPaths).size !== normalizedPaths.length) throw new TypeError("changedPaths must not contain duplicates.");
  const hashes = plainObject(input.pathHashes, "pathHashes");
  if (Object.keys(hashes).length !== normalizedPaths.length || normalizedPaths.some((file) => typeof hashes[file] !== "string" || !/^[0-9a-f]{64}$/.test(hashes[file]))) throw new TypeError("pathHashes must contain one string SHA-256 digest per changed path.");
  const mappings = plainObject(input.artifactMappings, "artifactMappings");
  if (Object.keys(mappings).length > 256) throw new TypeError("artifactMappings must contain at most 256 entries.");
  for (const [source, target] of Object.entries(mappings)) {
    validateRelativePath(source, { allowDirectoryPrefix: false });
    boundedString(target, "artifact mapping target");
  }
  const agent = plainObject(input.agent, "agent");
  const checkedAgent = {
    name: boundedString(agent.name, "agent.name", 128),
    paneId: boundedString(agent.paneId, "agent.paneId", 256),
    kind: boundedString(agent.kind, "agent.kind", 128),
    session: boundedString(agent.session, "agent.session", 512),
  };
  return Object.freeze({
    version: 1,
    ticketId: validateTicketId(input.ticketId),
    baseSha: sha(input.baseSha, "baseSha"),
    headSha: sha(input.headSha, "headSha"),
    branch: boundedString(input.branch, "branch"),
    worktreePath: boundedString(input.worktreePath, "worktreePath"),
    changedPaths: normalizedPaths,
    pathHashes: Object.freeze({ ...hashes }),
    patchPath: validateRelativePath(input.patchPath, { allowDirectoryPrefix: false }),
    patchSha256: /^[0-9a-f]{64}$/.test(input.patchSha256 ?? "") ? input.patchSha256 : (() => { throw new TypeError("patchSha256 must be a SHA-256 digest."); })(),
    artifactMappings: Object.freeze({ ...mappings }),
    validationLog: validateRelativePath(input.validationLog, { allowDirectoryPrefix: false }),
    agent: Object.freeze(checkedAgent),
  });
}
