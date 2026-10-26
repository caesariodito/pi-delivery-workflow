import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import { createDeliveryWorkflowCore } from "./delivery-workflow-core.mjs";

const Text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const Run = Type.Object({ runId: Text(128) }, { additionalProperties: false });
const Message = Type.Object({ runId: Text(128), ticketId: Text(128), message: Text(16_000) }, { additionalProperties: false });
const COMMAND_PROMPT = `Use the delivery-workflow skill for this objective:\n\n{{OBJECTIVE}}\n\nStart in discovery mode. Keep small linear work direct. For workflow work, produce reviewed spec and plan before one explicit plan-wide implementation approval. Parent retains decisions and final acceptance. Use delivery tools only after approval.`;

export default function deliveryWorkflow(pi: ExtensionAPI) {
  const core = createDeliveryWorkflowCore();
  const register = (name: string, description: string, parameters: ReturnType<typeof Type.Object>, execute: (cwd: string, input: any) => Promise<any>) => {
    pi.registerTool({
      name, label: name, description, parameters,
      annotations: { readOnlyHint: name === "delivery_status", destructiveHint: name === "delivery_stop", idempotentHint: name === "delivery_status", openWorldHint: false },
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) { return execute(ctx.cwd, input); },
    });
    pi.registerCommand(name, {
      description: `${description} JSON arguments required.`,
      handler: async (args, ctx) => {
        try {
          const input = JSON.parse(args);
          if (!Check(parameters, input)) throw new TypeError([...Errors(parameters, input)].map((error) => error.message).join("; "));
          const output = await execute(ctx.cwd, input); const text = output.content?.find((item: { type: string }) => item.type === "text")?.text ?? JSON.stringify(output.details);
          ctx.ui.notify(text, output.isError ? "error" : "info");
        } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
      },
    });
  };

  register("delivery_review", "Launch fixed-model fresh read-only review.", Type.Object({ runId: Text(128), kind: Type.Union([Type.Literal("spec"), Type.Literal("plan"), Type.Literal("implementation")]), artifact: Text(4096), contextBundle: Text(4096), focus: Type.Optional(Text(4000)) }, { additionalProperties: false }), core.review);
  const command = { executable: Text(1024), args: Type.Array(Type.String({ maxLength: 8192 }), { maxItems: 256 }), cwd: Type.Optional(Text(1024)) };
  register("delivery_start", "Start approved detached delivery run.", Type.Object({ runId: Text(128), baseSha: Type.String({ pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" }), tickets: Text(131_072), worktreeRoot: Text(4096), validation: Type.Object(command, { additionalProperties: false }), maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })) }, { additionalProperties: false }), core.start);
  register("delivery_status", "Read durable delivery status.", Run, core.status);
  register("delivery_steer", "Queue bounded guidance for active ticket.", Message, core.steer);
  register("delivery_reply", "Reply to existing blocked-ticket question.", Message, core.reply);
  register("delivery_continue", "Continue after verified integration.", Type.Object({ runId: Text(128), integratedSha: Type.String({ pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" }) }, { additionalProperties: false }), core.continue);
  register("delivery_stop", "Request proven stop without cleanup.", Type.Object({ runId: Text(128), ticketId: Type.Optional(Text(128)) }, { additionalProperties: false }), core.stop);

  pi.registerCommand("delivery", {
    description: "Design, review, approve, and deliver non-trivial work",
    handler: async (args, ctx) => {
      const objective = args.trim();
      if (!objective) return void ctx.ui.notify("Usage: /delivery <objective>", "warning");
      if (!ctx.isIdle()) return void ctx.ui.notify("Agent busy. Queue /delivery after current work finishes.", "warning");
      pi.sendUserMessage(COMMAND_PROMPT.replace("{{OBJECTIVE}}", objective));
    },
  });
}
