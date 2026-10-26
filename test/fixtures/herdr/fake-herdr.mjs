import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HERDR_ARGV_LOG, `${JSON.stringify(args)}\n`);

if (process.env.HERDR_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.HERDR_DELAY_MS)));
if (process.env.HERDR_BIG_OUTPUT) {
  process.stdout.write("x".repeat(Number(process.env.HERDR_BIG_OUTPUT)));
  process.exit(0);
}
if (process.env.HERDR_MALFORMED) {
  process.stdout.write(fs.readFileSync(path.join(fixtureDir, "malformed.json"), "utf8"));
  process.exit(0);
}
if (process.env.HERDR_ERROR) {
  process.stderr.write(JSON.stringify({ id: "fixture", error: { code: "agent_blocked", message: "agent needs input" } }));
  process.exit(1);
}

const command = args.join(" ");
if (command === "--version") process.stdout.write("herdr 0.9.5\n");
else if (command === "status --json") process.stdout.write(fs.readFileSync(path.join(fixtureDir, process.env.HERDR_STATUS_FIXTURE || "status-0.9.5.json"), "utf8"));
else if (command.startsWith("integration status")) process.stdout.write("pi: current (v9) (/tmp/pi integration)\ncodex: not installed (/tmp/codex)\n");
else if (command.startsWith("agent read ")) process.stdout.write(fs.readFileSync(path.join(fixtureDir, "agent-read-recent-unwrapped.txt"), "utf8"));
else if (command.startsWith("worktree create ")) process.stdout.write(JSON.stringify({ id: "fixture", result: { type: "worktree_created", root_pane: { pane_id: "w1:p1" }, worktree: { path: "/tmp/work tree" } } }));
else if (command.startsWith("agent prompt ")) process.stdout.write(fs.readFileSync(path.join(fixtureDir, "agent-prompt-activity.json"), "utf8"));
else if (command.startsWith("agent wait ")) process.stdout.write(fs.readFileSync(path.join(fixtureDir, "agent-wait-blocked.json"), "utf8"));
else process.stdout.write(JSON.stringify({ id: "fixture", result: { type: "ok", argv: args } }));
