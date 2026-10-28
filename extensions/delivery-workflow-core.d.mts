export const WORKER_MODEL: "9router/cx/gpt-5.6-sol";
export function remainingOperationTimeout(deadlineMs: number, nowMs?: number): number;
export function waitForAgentDeadline(herdr: Record<string, (...args: any[]) => Promise<unknown>>, target: string, deadlineMs: number, now?: () => number): Promise<{ timedOut: boolean; response?: unknown; status?: string; deadlineMs: number; elapsedMs: number }>;
export function runValidation(spec: { executable: string; args: string[]; cwd?: string }, worktreePath: string, timeoutMs: number): Promise<{ passed: boolean; timedOut: boolean; outputExceeded: boolean; code: string | number; stdout: string; stderr: string; timeoutMs: number; elapsedMs: number }>;
export type ToolResult = { content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean };
export type DeliveryWorkflowCoreOptions = {
  herdr?: Record<string, (...args: any[]) => Promise<any>>;
  nonce?: () => string;
};
export function createDeliveryWorkflowCore(options?: DeliveryWorkflowCoreOptions): Readonly<{
  start(repositoryPath: string, input: Record<string, unknown>): Promise<ToolResult>;
  status(repositoryPath: string, input: { runId: string }): Promise<ToolResult>;
  reconcile(repositoryPath: string, input: { runId: string }): Promise<ToolResult>;
  steer(repositoryPath: string, input: { runId: string; ticketId: string; message: string }): Promise<ToolResult>;
  continue(repositoryPath: string, input: { runId: string; integratedSha: string }): Promise<ToolResult>;
  dispose(repositoryPath: string, input: { runId: string; ticketId: string; disposition: "approve" | "changes_requested" | "blocked" }): Promise<ToolResult>;
  cleanup(repositoryPath: string, input: { runId: string }): Promise<ToolResult>;
  stop(repositoryPath: string, input: { runId: string; ticketId?: string }): Promise<ToolResult>;
}>;
