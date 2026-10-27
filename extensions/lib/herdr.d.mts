export const HERDR_BASELINE_VERSION: "0.9.5";
export const HERDR_PROTOCOL: 22;
/** Maximum timeout accepted by one public Herdr adapter call. Longer deadlines require repeated calls. */
export const HERDR_MAX_TIMEOUT_MS: 300000;
export const EXTRACTION_VERDICT: "result-file-pointer";

export class HerdrError extends Error {
  code: string;
  command: string[];
  exitCode?: string | number;
  stderr: string;
}

export type AgentState = "idle" | "working" | "blocked" | "done" | "unknown";
export type JsonObject = Record<string, unknown>;

export function parseJsonOutput(stdout: string, label?: string): JsonObject;
export function checkCompatibility(version: string, protocol: number): { version: string; protocol: number; baseline: boolean };
export function buildChildEnvironment(source?: NodeJS.ProcessEnv, overrides?: NodeJS.ProcessEnv): Readonly<NodeJS.ProcessEnv>;

export interface HerdrAdapterOptions {
  executable?: string;
  executableArgs?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Per-call timeout in milliseconds, from 1 through HERDR_MAX_TIMEOUT_MS. */
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface HerdrAdapter {
  version(): Promise<string>;
  status(): Promise<{ client: JsonObject; server: JsonObject; update: unknown; compatibility: { version: string; protocol: number; baseline: boolean } }>;
  integrationStatus(options?: { outdatedOnly?: boolean }): Promise<Array<{ name: string; status: string; path: string | null }>>;
  workspaceList(): Promise<JsonObject>;
  worktreeList(options?: { workspace?: string; cwd?: string; trustRepository?: boolean }): Promise<JsonObject>;
  worktreeCreate(options?: { workspace?: string; cwd?: string; branch?: string; base?: string; path?: string; label?: string; focus?: boolean; trustRepository?: boolean }): Promise<JsonObject>;
  worktreeRemove(options: { workspace: string; force?: boolean; trustRepository?: boolean }): Promise<JsonObject>;
  agentStart(options: { name: string; kind: string; pane: string; timeout?: number; agentArgs?: string[] }): Promise<JsonObject>;
  agentPrompt(options: { target: string; prompt: string; wait?: boolean; until?: AgentState[]; timeout?: number }): Promise<JsonObject>;
  /** Wait once, for at most HERDR_MAX_TIMEOUT_MS milliseconds. Repeat calls for longer deadlines. */
  agentWait(options: { target: string; until?: AgentState[]; timeout?: number }): Promise<JsonObject>;
  agentGet(target: string): Promise<JsonObject>;
  agentRead(options: { target: string; source?: "visible" | "recent" | "recent-unwrapped" | "detection"; lines?: number; format?: "text" | "ansi" }): Promise<string>;
  agentSendKeys(options: { target: string; keys: string[] }): Promise<JsonObject>;
  notify(options: { title: string; body?: string; position?: "top-left" | "top-right" | "bottom-left" | "bottom-right"; sound?: "none" | "done" | "request" }): Promise<JsonObject>;
}

export function createHerdrAdapter(options?: HerdrAdapterOptions): HerdrAdapter;
