import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function deliveryResultTool(pi: ExtensionAPI) {
  pi.registerFlag("delivery-result-path", { type: "string" });
  pi.registerFlag("delivery-result-nonce", { type: "string" });
  pi.registerTool({
    name: "delivery_result_write",
    label: "Delivery Result",
    description: "Write one nonce-bound ticket result. No arbitrary path is accepted.",
    parameters: Type.Object({
      nonce: Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9._-]+$" }),
      ticketId: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
      status: Type.Union([Type.Literal("done"), Type.Literal("blocked"), Type.Literal("failed")]),
      summary: Type.String({ minLength: 1, maxLength: 16_000 }),
      changedPaths: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 128 }),
      validation: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not_run")]),
      handoff: Type.String({ minLength: 1, maxLength: 8000 }),
      question: Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 4000 })]),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(_toolCallId, input) {
      const configuredPath = pi.getFlag("delivery-result-path"); const configuredNonce = pi.getFlag("delivery-result-nonce");
      if (typeof configuredPath !== "string" || !path.isAbsolute(configuredPath) || path.normalize(configuredPath) !== configuredPath) throw new Error("delivery result path is unavailable or invalid.");
      if (typeof configuredNonce !== "string" || input.nonce !== configuredNonce) throw new Error("delivery result nonce mismatch.");
      const { nonce: _nonce, ...ticketResult } = input; const body = `${JSON.stringify({ version: 1, ...ticketResult })}\n`;
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0); const fd = fs.openSync(configuredPath, flags, 0o600);
      try { fs.writeFileSync(fd, body, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return { content: [{ type: "text", text: "Delivery result saved." }], details: { status: "saved", path: configuredPath } };
    },
  });
}
