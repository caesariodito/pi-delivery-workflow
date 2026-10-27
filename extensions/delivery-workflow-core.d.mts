export const WORKER_MODEL: "9router/cx/gpt-5.6-sol";
export type ToolResult = { content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean };
export function createDeliveryWorkflowCore(options?: Record<string, unknown>): Readonly<{
  start(repositoryPath: string, input: Record<string, unknown>): Promise<ToolResult>;
  status(repositoryPath: string, input: { runId: string }): Promise<ToolResult>;
  steer(repositoryPath: string, input: { runId: string; ticketId: string; message: string }): Promise<ToolResult>;
  continue(repositoryPath: string, input: { runId: string; integratedSha: string }): Promise<ToolResult>;
  cleanup(repositoryPath: string, input: { runId: string }): Promise<ToolResult>;
  stop(repositoryPath: string, input: { runId: string; ticketId?: string }): Promise<ToolResult>;
}>;
