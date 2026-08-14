import assert from "node:assert/strict";
import test from "node:test";
import {
  annotateRepeatedToolFailures,
  buildInvalidFingerprint,
  collectPermissionDenials,
  detectRepeatedToolFailure,
} from "../../../src/agent/loop/toolFailure.js";
import type { SatiToolErrorResult, SatiToolResult } from "../../../src/tool/index.js";

/**
 * AgentLoop 工具失败分析纯函数行为基线测试（拆解专项）。
 */

function errorResult(toolName: string, code: string, message = "boom"): SatiToolErrorResult {
  return {
    type: "error",
    toolCallId: `${toolName}-1`,
    toolName,
    error: { code: code as SatiToolErrorResult["error"]["code"], message },
    content: [{ type: "text", text: message }],
    startedAt: "2026-08-14T00:00:00.000Z",
    completedAt: "2026-08-14T00:00:00.000Z",
  };
}

test("detectRepeatedToolFailure：首次失败无指纹，相同指纹后标记重复", () => {
  const first = detectRepeatedToolFailure([errorResult("write_file", "invalid_tool_input")], undefined);
  assert.equal(first.currentFingerprint, "write_file::invalid_tool_input::unknown");
  assert.equal(first.repeatedKeys.size, 0);

  const second = detectRepeatedToolFailure([errorResult("write_file", "invalid_tool_input")], first.currentFingerprint);
  assert.ok(second.repeatedKeys.has("write_file::invalid_tool_input::unknown"), "相同指纹应标记重复");
});

test("buildInvalidFingerprint：只统计 invalid_tool_input 并按内容排序", () => {
  const fingerprint = buildInvalidFingerprint([
    errorResult("b", "invalid_tool_input", "参数 X 非法"),
    errorResult("a", "invalid_tool_input", "参数 X 非法"),
    errorResult("c", "other_error", "无关"),
  ]);
  assert.equal(fingerprint, "a::参数 X 非法\nb::参数 X 非法");
});

test("annotateRepeatedToolFailures：重复失败追加避免重试提示并标记 metadata", () => {
  const repeated = errorResult("patent_search", "invalid_tool_input");
  const annotated = annotateRepeatedToolFailures(
    [repeated, errorResult("read_file", "invalid_tool_input")],
    new Set([`patent_search::invalid_tool_input::unknown`]),
  );
  assert.match((annotated[0]!.content[0] as { text: string }).text, /Repeated failure/);
  const recovery = annotated[0]!.metadata?.recovery as { repeatedFailure?: boolean } | undefined;
  assert.equal(recovery?.repeatedFailure, true);
  // 非重复结果不变。
  assert.doesNotMatch((annotated[1]!.content[0] as { text: string }).text, /Repeated failure/);
});

test("collectPermissionDenials：收集权限类错误为拒绝记录", () => {
  const denials = collectPermissionDenials([
    errorResult("write_file", "permission_denied"),
    errorResult("bash", "permission_required"),
    errorResult("read_file", "invalid_tool_input"),
  ] as SatiToolResult[]);
  assert.equal(denials.length, 2);
  assert.equal(denials[0]!.toolName, "write_file");
  assert.equal(denials[0]!.errorCode, "permission_denied");
  assert.equal(denials[1]!.errorCode, "permission_required");
});
