import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalMessage, CanonicalToolSchema } from "../../../src/model/index.js";
import { detectSubagent, stripSubagentTagFromMessages } from "../../../src/router/scenario/subagentDetector.js";

function userMessage(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function tool(name: string): CanonicalToolSchema {
  return { name, description: "", inputSchema: {} };
}

test("主 agent、无 tag、含 agent 工具时不是子代理", () => {
  const result = detectSubagent([userMessage("普通请求")], [tool("agent")], true);
  assert.equal(result.isSubagent, false);
  assert.equal(result.missingAgentTool, false);
  assert.equal(result.taggedInUserMessage, false);
  assert.equal(result.modelHint, undefined);
});

test("tools 未提供时不判定 missingAgentTool", () => {
  const result = detectSubagent([userMessage("普通请求")], undefined, true);
  assert.equal(result.missingAgentTool, false);
  assert.equal(result.isSubagent, false);
});

test("sati-subagent-model tag 被识别并提取 modelHint", () => {
  const result = detectSubagent(
    [userMessage("<sati-subagent-model>gpt-4o</sati-subagent-model>请帮我")],
    [tool("agent")],
    true,
  );
  assert.equal(result.taggedInUserMessage, true);
  assert.equal(result.modelHint, "gpt-4o");
  assert.equal(result.isSubagent, true);
});

test("ccr-subagent-model tag 大小写不敏感匹配", () => {
  const result = detectSubagent(
    [userMessage("<CCR-SUBAGENT-MODEL> claude-sonnet </CCR-SUBAGENT-MODEL>")],
    [tool("agent")],
    true,
  );
  assert.equal(result.taggedInUserMessage, true);
  assert.equal(result.modelHint, "claude-sonnet");
});

test("工具列表不含 agent/task 类工具时判定 missingAgentTool", () => {
  const result = detectSubagent([userMessage("普通请求")], [tool("read_file"), tool("search")], true);
  assert.equal(result.missingAgentTool, true);
  assert.equal(result.isSubagent, true);
});

test("launch_agent 风格工具名也能识别为 agent 工具", () => {
  const result = detectSubagent([userMessage("普通请求")], [tool("launch_agent")], true);
  assert.equal(result.missingAgentTool, false);
});

test("非主 agent 请求判定为子代理", () => {
  const result = detectSubagent([userMessage("普通请求")], [tool("agent")], false);
  assert.equal(result.isSubagent, true);
});

test("多条消息时最后一个 tag 胜出", () => {
  const messages = [
    userMessage("<sati-subagent-model>model-a</sati-subagent-model>第一条"),
    userMessage("<sati-subagent-model>model-b</sati-subagent-model>第二条"),
  ];
  const result = detectSubagent(messages, [tool("agent")], true);
  assert.equal(result.modelHint, "model-b");
});

test("stripSubagentTagFromMessages：剥离 tag 并清理尾部空白", () => {
  const stripped = stripSubagentTagFromMessages([
    userMessage("<sati-subagent-model>gpt-4o</sati-subagent-model>请分析"),
  ]);
  assert.equal((stripped[0]!.content[0] as { text: string }).text, "请分析");
});

test("stripSubagentTagFromMessages：非 user 消息原样返回", () => {
  const message: CanonicalMessage = { role: "assistant", content: [{ type: "text", text: "回复" }] };
  const stripped = stripSubagentTagFromMessages([message]);
  assert.equal(stripped[0], message);
});

test("stripSubagentTagFromMessages：无 tag 时返回原引用", () => {
  const message = userMessage("没有 tag 的请求");
  const stripped = stripSubagentTagFromMessages([message]);
  assert.equal(stripped[0], message);
});
