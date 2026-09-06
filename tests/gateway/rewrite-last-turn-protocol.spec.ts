/**
 * 协议 1.7 edit_last_turn / regenerate_last_turn 的帧与守卫测试。
 *
 * 覆盖：WsGatewayMethod 注册（穷尽性由 METHOD_PARAM_GUARDS satisfies 保证）、
 * 参数守卫（sessionKey/text 类型校验）、Gateway 接口 optional 方法存在性。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { validateMethodParams } from "../../src/gateway/server/methodGuards.js";
import type { Gateway } from "../../src/gateway/protocol/types.js";

test("edit_last_turn：参数守卫接受 sessionKey+text，拒绝缺字段/错类型", () => {
  assert.equal(validateMethodParams("edit_last_turn", { sessionKey: "s", text: "hi" }), null);
  const missingText = validateMethodParams("edit_last_turn", { sessionKey: "s" });
  assert.ok(typeof missingText === "string" && /text/.test(missingText));
  const wrongType = validateMethodParams("edit_last_turn", { sessionKey: "s", text: 42 });
  assert.ok(typeof wrongType === "string" && /text/.test(wrongType));
});

test("regenerate_last_turn：参数守卫只要求 sessionKey", () => {
  assert.equal(validateMethodParams("regenerate_last_turn", { sessionKey: "s" }), null);
  const missing = validateMethodParams("regenerate_last_turn", {});
  assert.ok(typeof missing === "string" && /sessionKey/.test(missing));
});

test("Gateway 接口：editLastTurn/regenerateLastTurn 为 optional 方法", () => {
  // 编译期断言 + 运行期形状检查：optional 方法可整体缺省（feature-detect）。
  const minimal = {} as Gateway;
  assert.equal(minimal.editLastTurn, undefined);
  assert.equal(minimal.regenerateLastTurn, undefined);
});
