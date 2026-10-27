import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import { createDeliveryWorkflowCore } from "./delivery-workflow-core.mjs";

const Text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const Run = Type.Object({ runId: Text(128) }, { additionalProperties: false });
const Message = Type.Object({ runId: Text(128), ticketId: Text(128), message: Text(16_000) }, { additionalProperties: false });
const COMMAND_PROMPT = `Use the delivery-workflow skill for this objective:\n\n{{OBJECTIVE}}\n\nKeep small linear work direct. For workflow work, produce a reviewed plan and bounded ticket graph before explicit implementation approval. Use the thin Herdr delivery tools only after approval. Parent retains decisions, integration, cleanup, and publication.`;

export default function deliveryWorkflow(pi: ExtensionAPI) {
  const core = createDeliveryWorkflowCore();
  const register = (name: string, description: string, parameters: ReturnType<typeof Type.Object>, execute: (cwd: string, input: any) => Promise<any>) => {
    pi.registerTool({ name, label: name, description, parameters, annotations: { readOnlyHint: name === "delivery_status", destructiveHint: ["delivery_stop", "delivery_cleanup"].includes(name), idempotentHint: ["delivery_status", "delivery_cleanup"].includes(name), openWorldHint: false }, async execute(_id, input, _signal, _update, ctx) { return execute(ctx.cwd, input); } });
    pi.registerCommand(name, { description: `${description} JSON arguments required.`, handler: async (args, ctx) => { try { const input = JSON.parse(args); if (!Check(parameters, input)) throw new TypeError([...Errors(parameters, input)].map((error) => error.message).join("; ")); const output = await execute(ctx.cwd, input); ctx.ui.notify(output.content?.[0]?.text ?? JSON.stringify(output.details), output.isError ? "error" : "info"); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); } } });
  };
  const Command = Type.Object({ executable: Text(1024), args: Type.Array(Type.String({ maxLength: 8192 }), { maxItems: 256 }), cwd: Type.Optional(Text(4096)) }, { additionalProperties: false });
  const Worker = Type.Object({ name: Text(128), kind: Type.Union([Type.Literal("pi"), Type.Literal("worker"), Type.Literal("reviewer")]), model: Text(256), thinking: Text(32), tools: Type.Array(Text(128), { minItems: 1, maxItems: 32 }) }, { additionalProperties: false });
  const Ticket = Type.Object({ id: Text(128), goal: Text(16_000), definitionOfDone: Text(16_000), dependencies: Type.Array(Text(128), { maxItems: 32 }), ownedPaths: Type.Array(Text(4096), { minItems: 1, maxItems: 64 }), forbiddenScope: Type.Optional(Text(16_000)), worker: Worker, validation: Command, requiresIntegratedBase: Type.Optional(Type.Boolean()), specPaths: Type.Optional(Type.Array(Text(4096), { maxItems: 32 })) }, { additionalProperties: false });
  register("delivery_start", "Run approved visible Herdr ticket graph in this Pi process.", Type.Object({ runId: Text(128), objective: Text(16_000), baseSha: Type.String({ pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" }), tickets: Type.Array(Ticket, { minItems: 1, maxItems: 64 }), worktreeRoot: Text(4096), contextPaths: Type.Optional(Type.Array(Text(4096), { maxItems: 32 })), maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })) }, { additionalProperties: false }), core.start);
  register("delivery_status", "Read persisted inspection status.", Run, core.status);
  register("delivery_steer", "Send guidance to a currently active visible agent.", Message, core.steer);
  register("delivery_continue", "Verify exact integrated patches and continue dependent tickets.", Type.Object({ runId: Text(128), integratedSha: Type.String({ pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" }) }, { additionalProperties: false }), core.continue);
  register("delivery_cleanup", "Remove all safely integrated Herdr worktrees for a run.", Run, core.cleanup);
  register("delivery_stop", "Request interrupt without cleanup.", Type.Object({ runId: Text(128), ticketId: Type.Optional(Text(128)) }, { additionalProperties: false }), core.stop);
  pi.registerCommand("delivery", { description: "Plan and run visible supervised Herdr delivery", handler: async (args, ctx) => { const objective = args.trim(); if (!objective) return void ctx.ui.notify("Usage: /delivery <objective>", "warning"); if (!ctx.isIdle()) return void ctx.ui.notify("Agent busy. Queue /delivery after current work finishes.", "warning"); pi.sendUserMessage(COMMAND_PROMPT.replace("{{OBJECTIVE}}", objective)); } });
}
