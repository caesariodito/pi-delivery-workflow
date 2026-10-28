import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const forbiddenRuntime = ["registerWorkflowResource", "resolveReview", "resolveTicket", "runs.run"];

function runtimeFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? runtimeFiles(target) : /\.(?:[cm]?js|ts)$/.test(entry.name) ? [target] : [];
  });
}

function packagePath(target) {
  return target.replace(/^\.\//, "").split(path.sep).join("/");
}

function targetContents(target) {
  const relative = packagePath(target);
  const absolute = path.join(root, relative);
  return fs.statSync(absolute).isDirectory()
    ? fs.readdirSync(absolute, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => packagePath(path.relative(root, path.join(entry.parentPath, entry.name))))
    : [relative];
}

test("package has no legacy dependency or runtime imports", () => {
  assert.equal(manifest.dependencies?.["pi-subagents"], undefined);
  assert.equal(lock.packages[""]?.dependencies?.["pi-subagents"], undefined);
  assert.equal(lock.packages["node_modules/pi-subagents"], undefined);
  for (const file of runtimeFiles(path.join(root, "extensions"))) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /(?:from\s+|import\s*\(|require\s*\()["'][^"']*pi-subagents/);
    for (const symbol of forbiddenRuntime) assert.equal(source.includes(symbol), false, `${path.relative(root, file)} contains ${symbol}`);
  }
});

test("packed package contains thin Herdr workflow, scoped result tool, scheduler, and skill", () => {
  const pack = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" }));
  const files = new Set(pack[0].files.map(({ path: file }) => file));
  for (const target of manifest.pi.extensions) {
    const expected = packagePath(target);
    assert.ok(files.has(expected), `packed package missing pi.extensions target ${expected}`);
  }
  for (const target of manifest.pi.skills) {
    for (const expected of targetContents(target)) assert.ok(files.has(expected), `packed package missing pi.skills content ${expected}`);
  }
  for (const expected of [
    "extensions/reviewer-result-tool.ts",
    "extensions/delivery-workflow-core.mjs",
    "extensions/lib/herdr.mjs",
    "extensions/lib/scheduler.mjs",
    "skills/delivery-workflow/SKILL.md",
    "docs/architecture.md",
    "docs/operator-guide.md",
    "docs/safety-and-recovery.md",
    "docs/ticket-contract.md",
    "docs/tutorial.md",
    "README.md",
    "CONTRIBUTING.md",
  ]) assert.ok(files.has(expected), `packed package missing ${expected}`);
});
