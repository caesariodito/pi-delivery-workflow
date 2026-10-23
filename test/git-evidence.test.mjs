import assert from "node:assert/strict";
import test from "node:test";
import { createHandoffManifest, findOwnershipViolations, normalizeOwnership, parsePorcelainV1Z, sha256 } from "../extensions/lib/git-evidence.mjs";

test("hashes bytes with SHA-256", () => {
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("parses porcelain v1 NUL output including rename source", () => {
  assert.deepEqual(parsePorcelainV1Z(" M src/a.mjs\0R  src/new.mjs\0src/old.mjs\0?? test/a.mjs\0"), [
    { status: " M", path: "src/a.mjs" },
    { status: "R ", path: "src/new.mjs", originalPath: "src/old.mjs" },
    { status: "??", path: "test/a.mjs" },
  ]);
  assert.throws(() => parsePorcelainV1Z(" M src/a.mjs"), /end with NUL/);
});

test("finds paths outside exact and directory ownership", () => {
  const ownership = normalizeOwnership(["extensions/lib/", "package.json"]);
  assert.deepEqual(findOwnershipViolations(["extensions/lib/state.mjs", "package.json", "README.md"], ownership), ["README.md"]);
  assert.deepEqual(findOwnershipViolations(["src/a.mjs"], [{ path: "src", directory: true }]), []);
  assert.throws(() => findOwnershipViolations(["src/a.mjs"], [{ path: "src/", directory: true }]), /normalized/);
  assert.throws(() => normalizeOwnership(["src/**"]), /exact/);
});

test("creates bounded handoff manifest", () => {
  const digest = sha256("patch");
  const manifest = createHandoffManifest({
    ticketId: "T001",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    branch: "ticket/T001",
    worktreePath: "/tmp/worktree",
    changedPaths: ["src/a.mjs"],
    pathHashes: { "src/a.mjs": sha256("source") },
    patchPath: "evidence/T001.patch",
    patchSha256: digest,
    artifactMappings: { "evidence/log.txt": "/durable/T001/log.txt" },
    validationLog: "evidence/validation.log",
    agent: { name: "worker", paneId: "pane-1", kind: "pi", session: "session-1" },
  });
  assert.equal(manifest.version, 1);
  assert.equal(manifest.patchSha256, digest);
  assert.ok(Object.isFrozen(manifest));
  assert.throws(() => createHandoffManifest({ ...manifest, pathHashes: {} }), /pathHashes/);
  assert.throws(() => createHandoffManifest({ ...manifest, pathHashes: { "src/a.mjs": 123 } }), /string SHA-256/);
  assert.throws(() => createHandoffManifest({ ...manifest, baseSha: "a".repeat(41) }), /Git object ID/);
  assert.throws(() => createHandoffManifest({ ...manifest, baseSha: "A".repeat(40) }), /Git object ID/);
});
