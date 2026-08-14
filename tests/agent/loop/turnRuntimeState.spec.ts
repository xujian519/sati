import test from "node:test";
import assert from "node:assert/strict";
import type { AgentLoopInput } from "../../../src/agent/protocol/input.js";
import {
  MAX_CONSECUTIVE_EMPTY,
  MAX_JSON_SELF_CORRECT_RETRIES,
  MAX_OUTPUT_RECOVERY_LIMIT,
  MAX_SAME_INVALID_FINGERPRINT,
  TurnRuntimeState,
} from "../../../src/agent/loop/turnRuntimeState.js";

const baseInput = (): AgentLoopInput => ({
  sessionId: "s1",
  turnId: "t1",
  messages: [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
  ],
});

test("TurnRuntimeState 构造：复制消息、初始化计数与时间戳", () => {
  const state = new TurnRuntimeState(baseInput(), {}, "2026-08-14T00:00:00.000Z");
  assert.equal(state.messages.length, 2);
  assert.equal(state.messages[0]!.role, "user");
  // 复制而非共享引用
  const original = baseInput();
  state.messages.push({ role: "user", content: [{ type: "text", text: "extra" }] });
  assert.equal(original.messages.length, 2);
  assert.equal(state.turnCount, 1);
  assert.deepEqual(state.usage, {});
  assert.deepEqual(state.permissionDenials, []);
  assert.equal(state.startedAt, "2026-08-14T00:00:00.000Z");
  assert.equal(state.doomLoopFatalReason, undefined);
  assert.equal(state.lastModelUsage, undefined);
  assert.equal(state.structuredOutput, undefined);
  assert.equal(state.finalMessage, undefined);
  assert.equal(state.hasAttemptedCompact, false);
  assert.equal(state.maxOutputRecoveryCount, 0);
  assert.equal(state.sameInvalidFingerprintCount, 0);
  assert.ok(state.largeFileRepair);
});

test("TurnRuntimeState 构造：sticky 路由信息（有/无 invalidateSticky）", () => {
  const noSticky = new TurnRuntimeState(baseInput(), {}, "t");
  assert.equal(noSticky.stickyInfo, undefined);
  assert.equal(noSticky.previousTier, undefined);

  const withSticky = new TurnRuntimeState(
    baseInput(),
    {
      invalidateSticky: () => ({
        previousTier: "fast",
        previousProvider: "p",
        previousModel: "m",
        orchestrating: true,
      }),
    },
    "t",
  );
  assert.deepEqual(withSticky.stickyInfo, {
    previousTier: "fast",
    previousProvider: "p",
    previousModel: "m",
    orchestrating: true,
  });
  assert.equal(withSticky.previousTier, "fast");
});

test("pushTransientSyntheticPrompt：优先 uuid，回退自增计数，记录 transientId", () => {
  const state = new TurnRuntimeState(baseInput(), { uuid: () => "uuid-1" }, "t");
  state.pushTransientSyntheticPrompt("resume", "max_output_recovery");
  assert.equal(state.messages.length, 3);
  const last = state.messages.at(-1)!;
  assert.equal(last.role, "user");
  assert.equal(last.metadata?.transientId, "uuid-1");
  assert.equal(last.metadata?.purpose, "max_output_recovery");
  assert.ok(state.activeTransientPromptIds.has("uuid-1"));

  const noUuid = new TurnRuntimeState(baseInput(), {}, "t");
  noUuid.pushTransientSyntheticPrompt("a", "p1");
  noUuid.pushTransientSyntheticPrompt("b", "p2");
  assert.equal(noUuid.messages.at(-1)!.metadata?.transientId, "transient-2");
  assert.equal(noUuid.activeTransientPromptIds.size, 2);
});

test("expireConsumedTransientPrompts：移除已消费的 transient 消息并清空记录", () => {
  const state = new TurnRuntimeState(baseInput(), { uuid: () => "t-x" }, "t");
  state.pushTransientSyntheticPrompt("resume", "max_output_recovery");
  state.expireConsumedTransientPrompts();
  assert.equal(state.messages.length, 2);
  assert.equal(state.activeTransientPromptIds.size, 0);
  // 无 active 时为空操作
  state.expireConsumedTransientPrompts();
  assert.equal(state.messages.length, 2);
});

test("恢复上限常量锁定", () => {
  assert.equal(MAX_OUTPUT_RECOVERY_LIMIT, 50);
  assert.equal(MAX_CONSECUTIVE_EMPTY, 3);
  assert.equal(MAX_JSON_SELF_CORRECT_RETRIES, 3);
  assert.equal(MAX_SAME_INVALID_FINGERPRINT, 3);
});

test("doomLoopFatalReason 可跨阶段读写", () => {
  const state = new TurnRuntimeState(baseInput(), {}, "t");
  state.doomLoopFatalReason = "fatal:loop";
  assert.equal(state.doomLoopFatalReason, "fatal:loop");
});
