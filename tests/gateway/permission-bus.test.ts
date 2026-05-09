import test from "node:test";
import assert from "node:assert/strict";
import { GatewayPermissionBus } from "../../src/gateway/permission/GatewayPermissionBus.js";

test("GatewayPermissionBus consume returns and removes pending entries", () => {
  const bus = new GatewayPermissionBus();
  let resolved: unknown;
  bus.register("session-a", {
    requestId: "r1",
    toolCallId: "tc1",
    toolName: "Bash",
    resolve: (decision) => {
      resolved = decision;
    },
    reject: () => undefined,
  });

  assert.equal(bus.pendingCount("session-a"), 1);
  const entry = bus.consume("session-a", "r1");
  entry?.resolve({ requestId: "r1", decision: "allow" });
  assert.deepEqual(resolved, { requestId: "r1", decision: "allow" });
  assert.equal(bus.pendingCount("session-a"), 0);
  assert.equal(bus.consume("session-a", "r1"), undefined);
});

test("GatewayPermissionBus rejectSession drops every pending entry", () => {
  const bus = new GatewayPermissionBus();
  let rejected: Error | undefined;
  bus.register("session-a", {
    requestId: "r1",
    toolCallId: "tc1",
    toolName: "Bash",
    resolve: () => undefined,
    reject: (error) => {
      rejected = error;
    },
  });
  bus.rejectSession("session-a", "turn_ended");
  assert.match(rejected?.message ?? "", /turn_ended/);
  assert.equal(bus.pendingCount("session-a"), 0);
});
