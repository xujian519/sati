/**
 * Mid-turn steering 协议面测试（协议 1.6）。
 *
 * 覆盖：AgentEvent → GatewayEvent 映射（steer_applied/steer_unapplied 带
 * runId）、协议版本 1.6、方法参数守卫（steer_turn/cancel_steer）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mapAgentEvent } from "../../src/gateway/client/InProcessGateway.js";
import { validateMethodParams } from "../../src/gateway/server/methodGuards.js";
import { SATI_GATEWAY_PROTOCOL_VERSION, isProtocolCompatible } from "../../src/gateway/protocol/version.js";

test("mapAgentEvent：steer_applied/steer_unapplied 透传并附 runId", () => {
  const applied = mapAgentEvent(
    {
      type: "steer_applied",
      sessionId: "session-1",
      turnId: "turn-1",
      steerId: "steer-1",
      preview: "顺便看看 b.md",
    },
    "run-1",
  );
  assert.equal(applied.length, 1);
  assert.equal(applied[0]?.type, "steer_applied");
  assert.equal(applied[0]?.runId, "run-1");
  if (applied[0]?.type === "steer_applied") {
    assert.equal(applied[0].steerId, "steer-1");
    assert.equal(applied[0].preview, "顺便看看 b.md");
  }

  const unapplied = mapAgentEvent(
    {
      type: "steer_unapplied",
      sessionId: "session-1",
      steerId: "steer-2",
      preview: "来不及了",
      reason: "turn_aborted",
    },
    "run-1",
  );
  assert.equal(unapplied.length, 1);
  assert.equal(unapplied[0]?.type, "steer_unapplied");
  assert.equal(unapplied[0]?.runId, "run-1");
  if (unapplied[0]?.type === "steer_unapplied") {
    assert.equal(unapplied[0].reason, "turn_aborted");
  }
});

test("协议版本 1.6+：同 MAJOR 兼容，低 MINOR 客户端可连接", () => {
  // 协议已升至 1.7（edit-last-turn），此处只锁 MAJOR=1 与 1.6 引入的兼容语义。
  assert.ok(SATI_GATEWAY_PROTOCOL_VERSION.startsWith("1."));
  assert.ok(isProtocolCompatible(SATI_GATEWAY_PROTOCOL_VERSION, SATI_GATEWAY_PROTOCOL_VERSION));
  assert.ok(isProtocolCompatible("1.6", SATI_GATEWAY_PROTOCOL_VERSION));
  assert.ok(isProtocolCompatible("1.0", SATI_GATEWAY_PROTOCOL_VERSION));
  assert.ok(!isProtocolCompatible("2.0", SATI_GATEWAY_PROTOCOL_VERSION));
});

test("方法守卫：steer_turn 要求 sessionKey+text，cancel_steer 要求 sessionKey+steerId", () => {
  assert.equal(validateMethodParams("steer_turn", { sessionKey: "k", text: "hi" }), null);
  assert.match(validateMethodParams("steer_turn", { sessionKey: "k" }) ?? "", /text/);
  assert.match(validateMethodParams("steer_turn", { sessionKey: "k", text: 42 }) ?? "", /text/);
  assert.equal(validateMethodParams("cancel_steer", { sessionKey: "k", steerId: "s-1" }), null);
  assert.match(validateMethodParams("cancel_steer", { sessionKey: "k" }) ?? "", /steerId/);
});
