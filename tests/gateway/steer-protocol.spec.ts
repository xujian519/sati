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
import {
  SATI_GATEWAY_PROTOCOL_VERSION,
  PROTOCOL_RELEASES,
  isProtocolCompatible,
} from "../../src/gateway/protocol/version.js";

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

test("协议版本 MAJOR=1：同 MAJOR 任意 MINOR 兼容（含更低 MINOR 的旧客户端）", () => {
  // 本用例只锁**兼容语义**——版本号本身是 version.ts 台账的一部分，由
  // `pnpm check:protocol-version` 与 protocol-versioning.spec.ts 把关。
  // 旧的 `startsWith("1.")` + 自比 `isProtocolCompatible(V, V)` 是无牙齿断言
  // （#362）：前者对 1.x 全部取值通过，后者两侧同源恒真。
  assert.equal(SATI_GATEWAY_PROTOCOL_VERSION, PROTOCOL_RELEASES[PROTOCOL_RELEASES.length - 1].version);
  assert.equal(isProtocolCompatible("1.6", SATI_GATEWAY_PROTOCOL_VERSION), true);
  assert.equal(isProtocolCompatible("1.0", SATI_GATEWAY_PROTOCOL_VERSION), true);
  assert.equal(isProtocolCompatible(SATI_GATEWAY_PROTOCOL_VERSION, "1.0"), true);
  assert.equal(isProtocolCompatible("2.0", SATI_GATEWAY_PROTOCOL_VERSION), false);
  assert.equal(isProtocolCompatible("0.9", SATI_GATEWAY_PROTOCOL_VERSION), false);
});

test("方法守卫：steer_turn 要求 sessionKey+text，cancel_steer 要求 sessionKey+steerId", () => {
  assert.equal(validateMethodParams("steer_turn", { sessionKey: "k", text: "hi" }), null);
  assert.match(validateMethodParams("steer_turn", { sessionKey: "k" }) ?? "", /text/);
  assert.match(validateMethodParams("steer_turn", { sessionKey: "k", text: 42 }) ?? "", /text/);
  assert.equal(validateMethodParams("cancel_steer", { sessionKey: "k", steerId: "s-1" }), null);
  assert.match(validateMethodParams("cancel_steer", { sessionKey: "k" }) ?? "", /steerId/);
});
