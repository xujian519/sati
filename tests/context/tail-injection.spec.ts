/**
 * 尾部注入消息构造（2.3「系统提示分桶」的载体）。
 *
 * 覆盖：段落顺序与逐字节保留、空段落不产生消息（保持请求形状不变）、
 * `purpose` 标记可被识别（缓存布局与后续排除逻辑据此判定）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTailInjectionMessage,
  isTailInjection,
  TAIL_INJECTION_PURPOSE,
} from "../../src/context/prompt/tailInjection.js";
import { buildPromptDateNotice } from "../../src/context/prompt/promptDateNotice.js";

test("buildTailInjectionMessage：无段落（或全为空白）时返回 undefined", () => {
  assert.equal(buildTailInjectionMessage([]), undefined);
  assert.equal(buildTailInjectionMessage([{ source: "memory", text: "   " }]), undefined);
  assert.equal(buildTailInjectionMessage([{ source: "memory", text: "" }]), undefined);
});

test("buildTailInjectionMessage：按给定顺序逐字节保留各段原文，用空行连接", () => {
  const message = buildTailInjectionMessage([
    { source: "plan_todo", text: "You are executing an approved plan." },
    { source: "workspace_ledger", text: "<workspace-state>\nGoal: x\n</workspace-state>" },
    { source: "memory", text: "  <memory-context>hit</memory-context>  " },
  ]);

  assert.ok(message);
  assert.equal(message.role, "user");
  assert.equal(message.metadata?.synthetic, true);
  assert.equal(message.metadata?.purpose, TAIL_INJECTION_PURPOSE);
  assert.equal(message.content.length, 1);
  const block = message.content[0];
  assert.equal(block?.type, "text");
  assert.equal(
    block?.type === "text" ? block.text : "",
    "You are executing an approved plan.\n\n" +
      "<workspace-state>\nGoal: x\n</workspace-state>\n\n" +
      "<memory-context>hit</memory-context>",
  );
});

test("isTailInjection：只认尾部注入，不误判其他合成消息", () => {
  const message = buildTailInjectionMessage([{ source: "memory", text: "hit" }]);
  assert.ok(message !== undefined && isTailInjection(message));
  assert.equal(isTailInjection(buildPromptDateNotice("2026-09-21")), false);
  assert.equal(isTailInjection({ role: "user", content: [{ type: "text", text: "hi" }] }), false);
  assert.equal(
    isTailInjection({ role: "user", content: [], metadata: { purpose: TAIL_INJECTION_PURPOSE } }),
    false,
    "缺 synthetic 标记不算尾部注入",
  );
});
