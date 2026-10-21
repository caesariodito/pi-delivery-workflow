export const REVIEWER_MODEL: string;
export const WORKER_MODEL: string;

export type WorkflowResolution = { script: string } | { error: string };

export function resolveReview(args: Readonly<Record<string, unknown>>): WorkflowResolution;
export function resolveTicket(args: Readonly<Record<string, unknown>>): WorkflowResolution;
