import type { CommandSpec, LifecycleState } from "./contracts.mjs";
import type { HandoffManifest } from "./git-evidence.mjs";
import type { HerdrAdapter } from "./herdr.mjs";
import type { ProcessRunner } from "./runner.mjs";

export type SchedulerTicket = Readonly<{ id: string; dependencies: string[]; batch: number; ownedPaths: string[]; worktreePath: string; worker: Readonly<{ name: string; pane: string; [key: string]: unknown }>; [key: string]: unknown }>;
export type SchedulerTicketState = { status: LifecycleState; attempt: number; agent?: { name: string; pane: string }; worktree?: string; manifest?: HandoffManifest; reason?: string; question?: string };
export type SchedulerState = { version: 1; runId: string; baseSha: string; phase: "ready" | "active" | "awaiting_integration" | "blocked" | "stopping" | "stopped" | "stop_unconfirmed" | "done"; tickets: Record<string, SchedulerTicketState>; completedSteps: string[]; nextAction: string; updatedAt: string };
export type IntegrationEvidence = Readonly<{ previousBaseSha: string; integratedSha: string; verifiedPaths: string[]; validation: { executable: string; args: string[] } }>;

export function validateTicketGraph(tickets: unknown): readonly SchedulerTicket[];
export function readyTickets(tickets: unknown, states: Record<string, SchedulerTicketState>): string[];
export function verifyIntegration(input: { previousBaseSha: string; integratedSha: string; manifests: HandoffManifest[]; repositoryPath: string; validation: CommandSpec }, deps: { processRunner: ProcessRunner }): Promise<IntegrationEvidence>;
export function reconcileRunner(runtimeDir: string, options?: { isProcessAlive?: (owner: Readonly<Record<string, unknown>>) => boolean }): Readonly<{ status: "available" | "stale" | "blocked"; reason?: string; owner?: Readonly<Record<string, unknown>> }>;
export function createScheduler(options: { repositoryPath: string; runtimeDir: string; runTicket: (ticket: SchedulerTicket) => Promise<{ status: string; manifest?: HandoffManifest; reason?: string }>; processRunner: ProcessRunner; herdr: HerdrAdapter; clock?: () => Date; isProcessAlive?: (owner: Readonly<Record<string, unknown>>) => boolean | undefined; runnerOwner?: { version: 1; pid: number; processStart: string; runId: string; createdAt: string }; runnerLockHeld?: boolean; maxConcurrency?: number }): Readonly<{
  startBatch(tickets: unknown): Promise<Readonly<Record<string, unknown>>>;
  /** T005 extension wiring must serialize calls; scheduler does not arbitrate concurrent consumers. */
  processInbox(options?: { tickets?: unknown; validation?: CommandSpec }): Promise<readonly Readonly<Record<string, unknown>>[]>;
  continueIntegration(input: string | { integratedSha: string; validation: CommandSpec }, tickets?: unknown): Promise<IntegrationEvidence>;
  recover(options?: { recoverTicket?: (ticketId: string, ticket: Readonly<SchedulerTicketState>) => Promise<Record<string, unknown>> }): Promise<Readonly<Record<string, unknown>>>;
}>;
