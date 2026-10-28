import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OVERRIDE_GUIDANCE = "Provide worktreeRoot as a writable normalized absolute real directory outside the repository, for example /Users/alice/.pi/delivery-worktrees/manual-project.";
const IDENTITY_DOMAIN = "pi-delivery-worktree-root:v1\0";

function fail(condition) { throw new Error(`${condition} ${OVERRIDE_GUIDANCE}`); }

export function normalizeRepositoryIdentity(repositoryRoot, pathApi = path) {
  let normalized = pathApi.normalize(repositoryRoot);
  const root = pathApi.parse(normalized).root;
  while (normalized.length > root.length && normalized.endsWith(pathApi.sep)) normalized = normalized.slice(0, -pathApi.sep.length);
  if (pathApi === path.win32) normalized = normalized.replaceAll("/", "\\").toLowerCase();
  return normalized;
}

export function repositoryIdentity(repositoryRoot, pathApi = path) {
  return crypto.createHash("sha256").update(IDENTITY_DOMAIN).update(normalizeRepositoryIdentity(repositoryRoot, pathApi)).digest("hex");
}

export function isPathInside(parent, candidate, pathApi = path) {
  const left = normalizeRepositoryIdentity(parent, pathApi);
  const right = normalizeRepositoryIdentity(candidate, pathApi);
  if (left === right) return false;
  const relative = pathApi.relative(left, right);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative);
}

export function repositorySlug(repositoryRoot, pathApi = path) {
  const slug = pathApi.basename(normalizeRepositoryIdentity(repositoryRoot, pathApi)).replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[._-]+|[._-]+$/g, "").slice(0, 48);
  return slug || "repository";
}

function canonicalDirectory(value, label, io, pathApi) {
  if (typeof value !== "string" || !pathApi.isAbsolute(value) || pathApi.normalize(value) !== value) fail(`${label} must be a normalized absolute path.`);
  let stat; let canonical;
  try { stat = io.lstatSync(value); canonical = io.realpathSync(value); } catch { fail(`${label} must exist and be accessible.`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a real directory, not a symlink.`);
  if (pathApi.normalize(canonical) !== canonical) fail(`${label} did not resolve to a normalized absolute path.`);
  return { canonical, stat };
}

function requireOutsideRepository(repositoryRoot, worktreeRoot, pathApi) {
  const repository = normalizeRepositoryIdentity(repositoryRoot, pathApi);
  const root = normalizeRepositoryIdentity(worktreeRoot, pathApi);
  if (repository === root || isPathInside(repository, root, pathApi)) fail("worktreeRoot must be outside the repository.");
}

function requireWritable(directory, io) {
  try { io.accessSync(directory, fs.constants.W_OK | fs.constants.X_OK); } catch { fail("worktreeRoot must be writable and searchable."); }
}

function requirePrivate(directory, io, getuid, platform) {
  if (platform === "win32" || typeof getuid !== "function") return;
  const stat = io.lstatSync(directory);
  if (stat.uid !== getuid()) fail(`Derived directory ${directory} must be owned by the current user.`);
  if ((stat.mode & 0o022) !== 0) fail(`Derived directory ${directory} must not be writable by group or other users.`);
}

export function resolveWorktreeRoot(repositoryRoot, explicitRoot, options = {}) {
  const io = options.fs ?? fs;
  const pathApi = options.path ?? path;
  const platform = options.platform ?? process.platform;
  const getuid = options.getuid ?? process.getuid;
  const home = options.home ?? os.homedir();
  const repository = canonicalDirectory(repositoryRoot, "Repository root", io, pathApi).canonical;

  if (explicitRoot !== undefined) {
    const worktreeRoot = canonicalDirectory(explicitRoot, "worktreeRoot", io, pathApi).canonical;
    requireOutsideRepository(repository, worktreeRoot, pathApi);
    requireWritable(worktreeRoot, io);
    return Object.freeze({ worktreeRoot, provenance: "override" });
  }

  const profile = canonicalDirectory(home, "User profile", io, pathApi).canonical;
  if (profile !== home) fail("User profile must be its canonical real path.");
  const piDirectory = pathApi.join(profile, ".pi");
  if (!io.existsSync(piDirectory)) {
    try { io.mkdirSync(piDirectory, { mode: 0o700 }); } catch { fail("User .pi directory could not be created."); }
  }
  canonicalDirectory(piDirectory, "User .pi directory", io, pathApi);

  const deliveryDirectory = pathApi.join(piDirectory, "delivery-worktrees");
  const versionDirectory = pathApi.join(deliveryDirectory, "v1");
  const derivedDirectory = pathApi.join(versionDirectory, `${repositorySlug(repository, pathApi)}-${repositoryIdentity(repository, pathApi)}`);
  requireOutsideRepository(repository, derivedDirectory, pathApi);
  try { io.mkdirSync(derivedDirectory, { recursive: true, mode: 0o700 }); } catch { fail("Derived worktree root could not be created."); }

  for (const directory of [deliveryDirectory, versionDirectory, derivedDirectory]) {
    canonicalDirectory(directory, `Derived directory ${directory}`, io, pathApi);
    requirePrivate(directory, io, getuid, platform);
  }
  const worktreeRoot = io.realpathSync(derivedDirectory);
  if (platform === "win32" && !isPathInside(profile, worktreeRoot, pathApi)) fail("Derived worktreeRoot must remain inside the user profile.");
  requireOutsideRepository(repository, worktreeRoot, pathApi);
  requireWritable(worktreeRoot, io);
  return Object.freeze({ worktreeRoot, provenance: "derived" });
}
