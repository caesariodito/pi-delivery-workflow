export const REVIEWER_MODEL: string;
export const WORKER_MODEL: string;

export type ToolResult = { content: { type: "text"; text: string }[]; details: Readonly<Record<string, unknown>>; isError?: boolean };
export type DeliveryWorkflowCore = Readonly<{
  review(repositoryPath: string, input: Readonly<Record<string, any>>): Promise<ToolResult>;
  start(repositoryPath: string, input: Readonly<Record<string, any>>): Promise<ToolResult>;
  status(repositoryPath: string, input: Readonly<Record<string, any>>): Promise<ToolResult>;
  steer(repositoryPath: string, input: Readonly<Record<string, any>>): Promise<ToolResult>;
  reply(repositoryPath: string, input: Readonly<Record<string, any>>): Promise<ToolResult>;
  continue(repositoryPath: string, input: Readonly<Record<string, any>>): Promise<ToolResult>;
  stop(repositoryPath: string, input: Readonly<Record<string, any>>): Promise<ToolResult>;
}>;
export function createDeliveryWorkflowCore(options?: Readonly<Record<string, any>>): DeliveryWorkflowCore;
export function runStandaloneReview(requestPath: string, options?: Readonly<Record<string, any>>): Promise<void>;
export function runDetachedDelivery(runtimeDir: string, options?: Readonly<Record<string, any>>): Promise<Readonly<Record<string, any>>>;
