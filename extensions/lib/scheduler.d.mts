export type CommandSpec = Readonly<{ executable: string; args: readonly string[]; cwd?: string }>;
export type IntegrationValidation = CommandSpec & Readonly<{ timeoutSeconds: number }>;
export type TicketContext = Readonly<{ observableBehavior?: readonly string[]; acceptanceExamples?: readonly string[]; nonGoals?: readonly string[]; entryPoints?: readonly string[]; invariants?: readonly string[]; expectedValidation?: readonly string[]; unresolvedDecisions?: readonly string[] }>;

export type ThinWorker = Readonly<{ name: string; kind: string; model: string; thinking: string; tools: readonly string[] }>;
export type TicketMode = "implementation" | "review";
export type ThinTicket = Readonly<{ id: string; mode: TicketMode; goal: string; definitionOfDone: string; dependencies: readonly string[]; ownedPaths: readonly string[]; readPaths?: readonly string[]; forbiddenScope: string; worker: ThinWorker; validation: CommandSpec; requiresIntegratedBase: boolean; specPaths: readonly string[]; maxFixRounds: number; timeoutSeconds: number; validationTimeoutSeconds: number; context?: TicketContext }>;
export type ThinRun = Readonly<{ runId: string; objective: string; baseSha: string; tickets: readonly ThinTicket[]; maxConcurrency: number; contextPaths: readonly string[]; integrationValidation?: IntegrationValidation }>;
export type ThinTicketState = { status: "pending" | "running" | "validation_passed" | "integrated" | "cleaned" | "blocked" | "failed" | "stopped"; handoff?: string };

export function validateTicketGraph(value: unknown): readonly ThinTicket[];
export function validateRunInput(value: unknown): ThinRun;
export function readyTickets(tickets: readonly ThinTicket[], states: Record<string, ThinTicketState>): string[];
export function blockedByIntegration(tickets: readonly ThinTicket[], states: Record<string, ThinTicketState>): boolean;
export function parsePorcelainV1Z(value: string | Buffer): readonly string[];
export type ImplementationResult = Readonly<{ version: 1; ticketId: string; status: "done" | "blocked" | "failed"; summary: string; changedPaths: readonly string[]; validation: "passed" | "failed" | "not_run"; handoff: string; question: string | null }>;
export type ReviewFinding = Readonly<{ severity: "critical" | "high" | "medium" | "low"; affectedPath: string; evidence: string; disposition: "open" }>;
export type ReviewResult = Readonly<{ version: 1; ticketId: string; verdict: "approve" | "changes_requested" | "blocked"; summary: string; findings: readonly ReviewFinding[]; residualRisks: readonly string[]; question: string | null }>;
export function validateTicketResult(value: unknown, ticketId: string, mode?: "implementation"): ImplementationResult;
export function validateTicketResult(value: unknown, ticketId: string, mode: "review"): ReviewResult;
export function validateTicketResult(value: unknown, ticketId: string, mode: TicketMode): ImplementationResult | ReviewResult;
export function buildContextPacket(input: { run: ThinRun; ticket: ThinTicket; repositoryPath: string; worktreePath: string; promptPath: string; resultPath: string; nonce: string; dependencyHandoffs?: readonly { ticketId: string; handoff: string }[]; guidance?: string }): string;
