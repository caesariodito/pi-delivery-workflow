import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../extensions/delivery-workflow.ts", import.meta.url), "utf8");

test("delivery ticket TypeBox surface exposes bounded Phase 2 controls", () => {
  for (const contract of [
    "maxFixRounds: Type.Optional(Type.Integer({ minimum: 0, maximum: 1 }))",
    "timeoutSeconds: Type.Optional(Type.Integer({ minimum: 60, maximum: 7200 }))",
    "validationTimeoutSeconds: Type.Optional(Type.Integer({ minimum: 30, maximum: 1800 }))",
  ]) assert.ok(source.includes(contract), `missing TypeBox contract: ${contract}`);
});

test("delivery tool list includes approved Phase 3 additions", () => {
  assert.deepEqual(
    [...source.matchAll(/register\("(delivery_[a-z]+)"/g)].map((match) => match[1]),
    ["delivery_start", "delivery_preview", "delivery_status", "delivery_reconcile", "delivery_steer", "delivery_continue", "delivery_dispose", "delivery_cleanup", "delivery_stop"],
  );
});
