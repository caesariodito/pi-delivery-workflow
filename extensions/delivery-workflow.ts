import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkflowResource } from "pi-subagents/workflow-resources";
import { resolveReview, resolveTicket } from "./delivery-workflow-core.mjs";

type WorkflowResourceRegistration = { dispose(): void };

const COMMAND_PROMPT = `Use the delivery-workflow skill for this objective:

{{OBJECTIVE}}

Start in discovery mode. Classify the request as direct, workflow candidate, or uncertain. Small linear work stays direct. For a workflow candidate, brainstorm with me and produce a reviewed spec and plan before requesting one explicit plan-wide implementation approval. Do not launch implementation subagents before that approval. Use native pi-subagents missions, async workflows, supervisor messaging, acceptance gates, and managed worktrees according to the skill. Parent retains all decisions and final acceptance.`;

export default function deliveryWorkflow(pi: ExtensionAPI) {
  let registrations: WorkflowResourceRegistration[] = [];

  pi.on("session_start", (_event, ctx) => {
    for (const registration of registrations) registration.dispose();
    registrations = [
      registerWorkflowResource({
        sessionId: ctx.sessionManager.getSessionId(),
        definition: { name: "delivery.review", version: 1, resolve: resolveReview },
      }),
      registerWorkflowResource({
        sessionId: ctx.sessionManager.getSessionId(),
        definition: { name: "delivery.ticket", version: 1, resolve: resolveTicket },
      }),
    ];
  });

  pi.on("session_shutdown", () => {
    for (const registration of registrations) registration.dispose();
    registrations = [];
  });

  pi.registerCommand("delivery", {
    description: "Design, review, approve, and deliver non-trivial work",
    handler: async (args, ctx) => {
      const objective = args.trim();
      if (!objective) {
        ctx.ui.notify("Usage: /delivery <objective>", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent busy. Queue /delivery after current work finishes.", "warning");
        return;
      }
      pi.sendUserMessage(COMMAND_PROMPT.replace("{{OBJECTIVE}}", objective));
    },
  });
}
