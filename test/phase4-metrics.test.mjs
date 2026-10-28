import assert from "node:assert/strict";
import test from "node:test";
import { analyzeRunMetrics, weightedCriticalPath } from "../extensions/lib/scheduler.mjs";

const tickets = [
  { id: "A", mode: "implementation", dependencies: [] },
  { id: "B", mode: "implementation", dependencies: ["A"] },
  { id: "C", mode: "review", dependencies: ["A"] },
  { id: "D", mode: "implementation", dependencies: ["B", "C"] },
];

const states = {
  A: { status: "cleaned", queuedAt: "2025-01-01T00:00:00.000Z", settledAt: "2025-01-01T00:00:04.000Z", cleanupEvidence: { cleanedAt: "2025-01-01T00:00:12.000Z" }, timing: { workerElapsedMs: 3_000, totalElapsedMs: 4_000 }, rounds: [{ validation: { passed: false } }, { validation: { passed: true } }], fixCount: 1 },
  B: { status: "blocked", queuedAt: "2025-01-01T00:00:01.000Z", settledAt: "2025-01-01T00:00:06.000Z", timing: { workerElapsedMs: 4_000, totalElapsedMs: 5_000 }, rounds: [{ validation: { passed: false } }], fixCount: 0 },
  C: { status: "cleaned", queuedAt: "2025-01-01T00:00:02.000Z", settledAt: "2025-01-01T00:00:10.000Z", reviewedAt: "2025-01-01T00:00:10.000Z", disposedAt: "2025-01-01T00:00:11.000Z", cleanupEvidence: { cleanedAt: "2025-01-01T00:00:13.000Z" }, timing: { workerElapsedMs: 7_000, totalElapsedMs: 8_000 }, rounds: [], fixCount: 0, reviewResult: { verdict: "approve" } },
  D: { status: "cleaned", queuedAt: "2025-01-01T00:00:03.000Z", settledAt: "2025-01-01T00:00:15.000Z", cleanupEvidence: { cleanedAt: "2025-01-01T00:00:16.000Z" }, timing: { workerElapsedMs: 6_000, totalElapsedMs: 12_000 }, rounds: [{ validation: { passed: true } }], fixCount: 0 },
};

test("reports run durations, utilization, lifecycle counts, and weighted path", () => {
  const metrics = analyzeRunMetrics({ tickets, states, maxConcurrency: 2 });
  assert.equal(metrics.wallTimeMs, 16_000);
  assert.equal(metrics.workerTimeMs, 20_000);
  assert.equal(metrics.utilization, 0.625);
  assert.deepEqual(metrics.counts, { validations: 4, fixes: 1, blocks: 1, reviews: 1, cleanups: 3 });
  assert.deepEqual(metrics.criticalPath, { ticketIds: ["A", "C", "D"], durationMs: 24_000, incomplete: false, missingTiming: [] });
  assert.deepEqual(metrics.incomplete, { wallTime: false, workerTime: false, utilization: false, criticalPath: false });
  assert.deepEqual(metrics.missingTiming, { wall: [], worker: [], criticalPath: [] });
});

test("weighted path uses deterministic lexical tie breaking", () => {
  const equal = { A: { timing: { totalElapsedMs: 2 } }, B: { timing: { totalElapsedMs: 3 } }, C: { timing: { totalElapsedMs: 3 } }, D: { timing: { totalElapsedMs: 1 } } };
  assert.deepEqual(weightedCriticalPath(tickets, equal), { ticketIds: ["A", "B", "D"], durationMs: 6, incomplete: false, missingTiming: [] });
});

test("missing timing stays unknown and receives explicit flags instead of guessed zero", () => {
  const incomplete = structuredClone(states); delete incomplete.B.timing.workerElapsedMs; delete incomplete.C.timing.totalElapsedMs; delete incomplete.D.settledAt; delete incomplete.D.cleanupEvidence;
  const metrics = analyzeRunMetrics({ tickets, states: incomplete, maxConcurrency: 2 });
  assert.equal(metrics.wallTimeMs, null);
  assert.equal(metrics.workerTimeMs, null);
  assert.equal(metrics.utilization, null);
  assert.deepEqual(metrics.criticalPath, { ticketIds: null, durationMs: null, incomplete: true, missingTiming: ["C"] });
  assert.deepEqual(metrics.incomplete, { wallTime: true, workerTime: true, utilization: true, criticalPath: true });
  assert.deepEqual(metrics.missingTiming, { wall: ["D"], worker: ["B"], criticalPath: ["C"] });
});
