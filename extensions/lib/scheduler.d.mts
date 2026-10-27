export type CommandSpec = Readonly<{ executable: string; args: readonly string[]; cwd?: string }>;

export type ThinWorker = Readonly<{ name: string; kind: string; model: string; thinking: string; tools: readonly string[] }>;
export type ThinTicket = Readonly<{ id: string; goal: string; definitionOfDone: string; dependencies: readonly string[]; ownedPaths: readonly string[]; forbiddenScope: string; worker: ThinWorker; validation: CommandSpec; requiresIntegratedBase: boolean; specPaths: readonly string[] }>;
export type ThinRun = Readonly<{ runId: string; objective: string; baseSha: string; tickets: readonly ThinTicket[]; maxConcurrency: number; contextPaths: readonly string[] }>;
export type ThinTicketState = { status: "pending" | "running" | "validation_passed" | "integrated" | "cleaned" | "blocked" | "failed" | "stopped"; handoff?: string };

export function validateTicketGraph(value: unknown): readonly ThinTicket[];
export function validateRunInput(value: unknown): ThinRun;
export function readyTickets(tickets: readonly ThinTicket[], states: Record<string, ThinTicketState>): string[];
export function blockedByIntegration(tickets: readonly ThinTicket[], states: Record<string, ThinTicketState>): boolean;
export function parsePorcelainV1Z(value: string | Buffer): readonly string[];
export function validateTicketResult(value: unknown, ticketId: string): Readonly<{ version: 1; ticketId: string; status: "done" | "blocked" | "failed"; summary: string; changedPaths: readonly string[]; validation: "passed" | "failed" | "not_run"; handoff: string; question: string | null }>;
export function buildContextPacket(input: { run: ThinRun; ticket: ThinTicket; repositoryPath: string; worktreePath: string; promptPath: string; resultPath: string; nonce: string; dependencyHandoffs?: readonly { ticketId: string; handoff: string }[]; guidance?: string }): string;
