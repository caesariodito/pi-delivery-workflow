import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const Finding = Type.Object({
  severity: Type.Union([Type.Literal("P0"), Type.Literal("P1"), Type.Literal("P2")]),
  location: Type.String({ minLength: 1, maxLength: 8192 }),
  problem: Type.String({ minLength: 1, maxLength: 8192 }),
  action: Type.String({ minLength: 1, maxLength: 8192 }),
}, { additionalProperties: false });

export default function reviewerResultTool(pi: ExtensionAPI) {
  pi.registerFlag("delivery-result-path", { type: "string" });
  pi.registerFlag("delivery-result-nonce", { type: "string" });
  pi.registerTool({
    name: "delivery_result_write",
    label: "Delivery Review Result",
    description: "Write one nonce-bound delivery review result. No arbitrary path is accepted.",
    parameters: Type.Object({
      nonce: Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9._-]+$" }),
      verdict: Type.Union([Type.Literal("ok"), Type.Literal("needs_fix"), Type.Literal("blocked")]),
      findings: Type.Array(Finding, { maxItems: 12 }),
      summary: Type.String({ minLength: 1, maxLength: 16_000 }),
      candidateHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(_toolCallId, input) {
      const configuredPath = pi.getFlag("delivery-result-path");
      const configuredNonce = pi.getFlag("delivery-result-nonce");
      if (typeof configuredPath !== "string" || !path.isAbsolute(configuredPath) || path.normalize(configuredPath) !== configuredPath) throw new Error("delivery result path is unavailable or invalid.");
      if (typeof configuredNonce !== "string" || input.nonce !== configuredNonce) throw new Error("delivery result nonce mismatch.");
      const { nonce: _nonce, ...review } = input;
      const body = `${JSON.stringify({ version: 1, ...review })}\n`;
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
      const fd = fs.openSync(configuredPath, flags, 0o600);
      try { fs.writeFileSync(fd, body, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return { content: [{ type: "text", text: "Delivery review result saved." }], details: { status: "saved", path: configuredPath } };
    },
  });
}
