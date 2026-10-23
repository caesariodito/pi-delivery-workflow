import type { CommandSpec } from "./contracts.mjs";
import type { HandoffManifest } from "./git-evidence.mjs";
import type { HerdrAdapter } from "./herdr.mjs";

export type AgentContract = Readonly<{ name: string; kind: string; pane: string; model: string; session: string }>;
export type TicketRunContract = Readonly<{
  version: 1;
  runId: string;
  ticketId: string;
  planApproved: true;
  repositoryPath: string;
  worktreePath: string;
  baseSha: string;
  branch: string;
  ticket: string;
  context: string;
  ownedPaths: string[];
  forbiddenPaths: string[];
  validation: CommandSpec;
  maxFixRounds: number;
  worker: AgentContract;
  reviewer: AgentContract;
  artifactMappings: Readonly<Record<string, string>>;
}>;
export type ProcessResult = { code: number | null; signal?: NodeJS.Signals | null; timedOut?: boolean; outputLimit?: boolean; stdout: string | Buffer; stderr: string | Buffer };
export interface ProcessRunner { run(spec: CommandSpec): Promise<ProcessResult>; }
export type TicketResult = Readonly<{
  ticketId: string;
  status: "done";
  candidateHash: string;
  manifest: HandoffManifest;
  manifestPath: string;
}> | Readonly<{
  ticketId: string;
  status: "blocked";
  reason: string;
  evidence: Readonly<Record<string, unknown>>;
}>;
export type RecoveryResult = Readonly<{
  ticketId: string;
  status: "recovered";
  target: string;
  kind: "worker" | "review";
  result: Readonly<Record<string, unknown>>;
}> | Extract<TicketResult, { status: "blocked" }>;

export const RESULT_PROTOCOL: "result-file-pointer";
export const REVIEW_TOOLS: readonly ["read", "grep", "find", "ls"];
export function validateTicketRunContract(value: unknown): TicketRunContract;
export function createProcessRunner(options?: { timeoutMs?: number; maxOutputBytes?: number }): ProcessRunner;
export function createDeliveryRunner(options: {
  herdr: HerdrAdapter & { extractionVerdict?: string; resultProtocol?: string };
  processRunner?: ProcessRunner;
  clock?: () => Date;
  random?: () => string | number;
  notifier?: (message: { title: string; body: string; sound: "done" }) => void | Promise<void>;
}): Readonly<{
  runTicket(input: unknown): Promise<TicketResult>;
  recoverSettledResult(input: unknown, identity?: { expectedTarget?: string; expectedKind?: "worker" | "review"; expectedCandidateHash?: string }): Promise<RecoveryResult>;
}>;
