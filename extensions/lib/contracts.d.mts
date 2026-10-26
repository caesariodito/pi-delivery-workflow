export type LifecycleState = "ready" | "allocating" | "active" | "validating" | "review" | "needs_fix" | "stopping" | "stopped" | "stop_unconfirmed" | "done" | "awaiting_integration" | "blocked";
export type OwnershipPath = Readonly<{ path: string; directory: boolean }>;
export type CommandSpec = Readonly<{ executable: string; args: string[]; cwd?: string }>;
export type ControlRequest = Readonly<{ version: 1; requestId: string; runId: string; action: "stop" | "status" | "message"; message?: string; createdAt: string }>;

export const LIFECYCLE_TRANSITIONS: Readonly<Record<LifecycleState, readonly LifecycleState[]>>;
export function validateRunId(value: unknown): string;
export function validateTicketId(value: unknown): string;
export function validateRequestId(value: unknown): string;
export function validateRelativePath(value: unknown, options?: { allowDirectoryPrefix?: boolean }): string;
export function validateOwnedPaths(value: unknown): OwnershipPath[];
export function validateOwnershipPath(value: unknown): OwnershipPath;
export function pathsOverlap(left: string | OwnershipPath, right: string | OwnershipPath): boolean;
export function validateLifecycleTransition(from: unknown, to: unknown): LifecycleState;
export function validateCommandSpec(value: unknown): CommandSpec;
export function validateControlRequest(value: unknown): ControlRequest;
