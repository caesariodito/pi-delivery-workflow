import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { validateTicketResult } from "./lib/scheduler.mjs";

export default function deliveryResultTool(pi: ExtensionAPI) {
  pi.registerFlag("delivery-result-path", { type: "string" });
  pi.registerFlag("delivery-result-nonce", { type: "string" });
  pi.registerFlag("delivery-result-binding-dir", { type: "string" });
  pi.registerFlag("delivery-result-mode", { type: "string" });
  const identity = {
    nonce: Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9._-]+$" }),
    ticketId: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
  };
  const implementationResult = Type.Object({
    ...identity,
    status: Type.Union([Type.Literal("done"), Type.Literal("blocked"), Type.Literal("failed")]),
    summary: Type.String({ minLength: 1, maxLength: 16_000 }),
    changedPaths: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 128 }),
    validation: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not_run")]),
    handoff: Type.String({ minLength: 1, maxLength: 8000 }),
    question: Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 4000 })]),
  }, { additionalProperties: false });
  const reviewResult = Type.Object({
    ...identity,
    verdict: Type.Union([Type.Literal("approve"), Type.Literal("changes_requested"), Type.Literal("blocked")]),
    summary: Type.String({ minLength: 1, maxLength: 16_000 }),
    findings: Type.Array(Type.Object({
      severity: Type.Union([Type.Literal("critical"), Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
      affectedPath: Type.String({ minLength: 1, maxLength: 4096 }),
      evidence: Type.String({ minLength: 1, maxLength: 8000 }),
      disposition: Type.Literal("open"),
    }, { additionalProperties: false }), { maxItems: 128 }),
    residualRisks: Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), { maxItems: 32 }),
    question: Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 4000 })]),
  }, { additionalProperties: false });
  const registerResultTool = () => pi.registerTool({
    name: "delivery_result_write",
    label: "Delivery Result",
    description: "Write one nonce-bound ticket result. No arbitrary path is accepted.",
    parameters: pi.getFlag("delivery-result-mode") === "review" ? reviewResult : implementationResult,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(_toolCallId, input) {
      const configuredPath = pi.getFlag("delivery-result-path"); const configuredNonce = pi.getFlag("delivery-result-nonce"); const bindingDir = pi.getFlag("delivery-result-binding-dir"); const mode = pi.getFlag("delivery-result-mode") ?? "implementation";
      if (mode !== "implementation" && mode !== "review") throw new Error("delivery result mode is invalid.");
      if ((mode === "review") !== ("verdict" in input)) throw new Error("delivery result does not match configured mode.");
      if (typeof configuredPath !== "string" || !path.isAbsolute(configuredPath) || path.normalize(configuredPath) !== configuredPath) throw new Error("delivery result path is unavailable or invalid.");
      let destination = configuredPath;
      if (bindingDir === undefined) {
        if (typeof configuredNonce !== "string" || input.nonce !== configuredNonce) throw new Error("delivery result nonce mismatch.");
      } else {
        if (typeof bindingDir !== "string" || !path.isAbsolute(bindingDir) || path.normalize(bindingDir) !== bindingDir) throw new Error("delivery result binding directory is invalid.");
        const directory = fs.lstatSync(bindingDir); if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("delivery result binding directory is invalid.");
        const names = fs.readdirSync(bindingDir).sort(); if (names.some((name) => !/^round-[01]\.json$/.test(name))) throw new Error("delivery result binding set is invalid.");
        const bindings = names.map((name) => {
          const file = path.join(bindingDir, name); const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("delivery result binding is invalid.");
          const value = JSON.parse(fs.readFileSync(file, "utf8"));
          if (!value || value.version !== 1 || value.round !== Number(name[6]) || value.ticketId !== input.ticketId || typeof value.nonce !== "string" || typeof value.resultPath !== "string") throw new Error("delivery result binding identity is invalid.");
          const expected = value.round === 0 ? configuredPath : path.join(path.dirname(configuredPath), `${input.ticketId}.fix-1.json`);
          if (value.resultPath !== expected || path.dirname(value.resultPath) !== path.dirname(configuredPath)) throw new Error("delivery result binding path is invalid.");
          return value;
        });
        if (!bindings.length || bindings[0].round !== 0 || bindings[0].nonce !== configuredNonce || bindings[0].resultPath !== configuredPath || (bindings.length === 2 && (!fs.existsSync(configuredPath) || bindings[1].round !== 1))) throw new Error("delivery result binding advancement is invalid.");
        const binding = bindings.find((value) => value.nonce === input.nonce); if (!binding) throw new Error("delivery result nonce mismatch."); destination = binding.resultPath;
      }
      const { nonce: _nonce, ...ticketResult } = input;
      const validated = validateTicketResult({ version: 1, ...ticketResult }, input.ticketId, mode); const body = `${JSON.stringify(validated)}\n`;
      if (Buffer.byteLength(body) > 64 * 1024) throw new Error("delivery result exceeds 64 KiB.");
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0); const fd = fs.openSync(destination, flags, 0o600);
      try { fs.writeFileSync(fd, body, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return { content: [{ type: "text", text: "Delivery result saved." }], details: { status: "saved", path: destination } };
    },
  });
  registerResultTool();
  // CLI flags arrive after extension loading; refresh before the first model request.
  pi.on("session_start", registerResultTool);
}
