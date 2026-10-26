import type { ControlRequest } from "./contracts.mjs";

export type RunnerLock = Readonly<{ version: 1; pid: number; ownershipToken: string; contractDigest?: string; runId: string; createdAt: string }>;
export function atomicWriteJson<T>(filePath: string, value: T): T;
export function appendJsonLine<T>(filePath: string, value: T): T;
export function writeExclusiveJson<T>(filePath: string, value: T): T;
export function readJson(filePath: string): unknown;
export function readSecureFile(filePath: string, maximum?: number): Buffer;
export function readSecureJson(filePath: string): unknown;
export function acquireRunnerLock(lockPath: string, owner: RunnerLock, options?: { isOwnerAlive?: (lock: Readonly<Record<string, unknown>>) => boolean }): RunnerLock;
export function releaseRunnerLock(lockPath: string, owner: RunnerLock): void;
export function writeInboxRequest(inboxPath: string, request: ControlRequest): ControlRequest;
export function writeReceipt<T extends { requestId: string }>(receiptsPath: string, receipt: T): T;
