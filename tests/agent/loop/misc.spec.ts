import assert from "node:assert/strict";
import test from "node:test";
import {
  composeAbortSignal,
  isPermissionMode,
  mergeUsage,
  mergeUserRules,
  subagentIdFromSessionId,
} from "../../../src/agent/loop/misc.js";
import type { PermissionRule } from "../../../src/permission/index.js";
import type { CanonicalUsage } from "../../../src/model/index.js";

/**
 * AgentLoop 杂项纯函数行为基线测试（拆解专项）。
 */

test("mergeUsage：合并两轮 usage（undefined 字段按 0 处理）", () => {
  const first: CanonicalUsage = { inputTokens: 100, outputTokens: 50 };
  const second: CanonicalUsage = { inputTokens: 30, outputTokens: undefined, cacheReadTokens: 10 };
  const merged = mergeUsage(first, second);
  assert.equal(merged.inputTokens, 130);
  assert.equal(merged.outputTokens, 50);
  assert.equal(merged.cacheReadTokens, 10);
  // second 为 undefined 时返回 first。
  assert.equal(mergeUsage(first, undefined), first);
});

test("subagentIdFromSessionId：提取 ::sub:: 后的子代理 id", () => {
  assert.equal(subagentIdFromSessionId("/proj::sub::sub-123"), "sub-123");
  assert.equal(subagentIdFromSessionId("plain-session"), undefined);
  assert.equal(subagentIdFromSessionId("/proj::sub::  "), undefined);
});

test("isPermissionMode：判定权限模式", () => {
  assert.equal(isPermissionMode("default"), true);
  assert.equal(isPermissionMode("plan"), true);
  assert.equal(isPermissionMode("bypassPermissions"), true);
  assert.equal(isPermissionMode("ask"), false);
  assert.equal(isPermissionMode(undefined), false);
});

test("mergeUserRules：user 规则整体替换为传入的 userRules，非 user 规则保留", () => {
  const target: PermissionRule[] = [
    { source: "project", behavior: "allow", toolName: "read_file" },
    { source: "user", behavior: "deny", toolName: "bash" },
  ];
  mergeUserRules(target, [{ source: "user", behavior: "allow", toolName: "write_file" }]);
  assert.deepEqual(
    target.map(r => `${r.source}:${r.toolName}`),
    ["project:read_file", "user:write_file"],
  );
});

test("composeAbortSignal：无父信号无超时返回空组合", () => {
  const composed = composeAbortSignal({});
  assert.equal(composed.signal, undefined);
  assert.equal(composed.timedOut(), false);
  composed.cleanup(); // 空操作不抛
});

test("composeAbortSignal：超时触发 abort 并标记 timedOut", async () => {
  const composed = composeAbortSignal({ timeoutMs: 20 });
  assert.ok(composed.signal, "有超时应创建 signal");
  const aborted = await new Promise<boolean>(resolve => {
    composed.signal!.addEventListener("abort", () => resolve(true), { once: true });
    setTimeout(() => resolve(false), 100);
  });
  assert.equal(aborted, true);
  assert.equal(composed.timedOut(), true);
  composed.cleanup();
});

test("composeAbortSignal：父信号已中止时立即传播", () => {
  const parent = new AbortController();
  parent.abort(new Error("parent aborted"));
  const composed = composeAbortSignal({ parent: parent.signal });
  assert.equal(composed.signal?.aborted, true);
  composed.cleanup();
});
