import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeGatewayModeForLegacyInput,
  normalizeGatewayRunMode,
  normalizePlanCommandInput,
  parsePlanCommand,
} from "../../../src/gateway/client/normalizers.js";
import type { GatewaySubmitTurnInput } from "../../../src/gateway/protocol/types.js";

test("normalizers: mode 归一化合法值透传、非法回退 default", () => {
  assert.equal(normalizeGatewayModeForLegacyInput("default"), "default");
  assert.equal(normalizeGatewayModeForLegacyInput("plan"), "plan");
  assert.equal(normalizeGatewayModeForLegacyInput("bypassPermissions"), "bypassPermissions");
  assert.equal(normalizeGatewayModeForLegacyInput("weird"), "default");
  assert.equal(normalizeGatewayModeForLegacyInput(undefined), undefined);
  assert.equal(normalizeGatewayModeForLegacyInput(""), undefined);
});

test("normalizers: runMode 归一化合法值透传、非法回退 agent", () => {
  assert.equal(normalizeGatewayRunMode("agent"), "agent");
  assert.equal(normalizeGatewayRunMode("plan"), "plan");
  assert.equal(normalizeGatewayRunMode("ask"), "ask");
  assert.equal(normalizeGatewayRunMode("whatever"), "agent");
  assert.equal(normalizeGatewayRunMode(undefined), undefined);
});

test("normalizers: parsePlanCommand 空 /plan 与带参数", () => {
  assert.deepEqual(parsePlanCommand("/plan"), { isPlanCommand: true, message: "" });
  assert.deepEqual(parsePlanCommand("/plan 设计一个功能"), { isPlanCommand: true, message: "设计一个功能" });
  assert.deepEqual(parsePlanCommand("普通消息"), { isPlanCommand: false, message: "普通消息" });
});

test("normalizers: normalizePlanCommandInput 改写为 plan 模式", () => {
  const input: GatewaySubmitTurnInput = { sessionKey: "s1", message: "/plan 设计功能", channelKey: "web" };
  const out = normalizePlanCommandInput(input);
  assert.ok(out);
  assert.equal(out.message, "设计功能");
  assert.equal(out.runMode, "plan");
  assert.equal(out.mode, "plan");
  assert.equal(out.allowPlanModeTools, true);
  assert.equal(out.basePermissionMode, "default");
});

test("normalizers: normalizePlanCommandInput 空 /plan 返回 undefined（引导用法）", () => {
  assert.equal(normalizePlanCommandInput({ sessionKey: "s1", message: "/plan", channelKey: "web" }), undefined);
  const plain = normalizePlanCommandInput({ sessionKey: "s1", message: "hello", channelKey: "web" });
  assert.ok(plain);
  assert.equal(plain.message, "hello");
});
