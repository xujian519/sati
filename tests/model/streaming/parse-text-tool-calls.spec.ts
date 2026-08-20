/**
 * parseTextToolCalls 解析器行为锁定（C04 重构 findBalancedEnd 泛化后的回归锁）。
 *
 * 覆盖：五格式（Qwen XML / DeepSeek DSML / Hermes JSON / Mistral / Llama）
 * 的完整解析、截断 partial、无效 JSON、嵌套/转义边界（findBalancedEnd 敏感点）、
 * 混合文本 remainingText。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { extractTextToolCalls } from "../../../src/model/streaming/parseTextToolCalls.js";

test("无工具调用文本：返回空结果，remainingText 原样保留", () => {
  const r = extractTextToolCalls("普通文本，没有工具调用。");
  assert.deepEqual(r.toolCalls, []);
  assert.equal(r.remainingText, "普通文本，没有工具调用。");
  assert.equal(r.partialToolCall, undefined);
  assert.equal(r.parseError, undefined);
});

test("Qwen XML：完整调用解析为 tool_call，input 为多参数映射", () => {
  const text =
    "<tool_call>\n<function=search>\n<parameter=query>专利 无效</parameter>\n<parameter=limit>10</parameter>\n</function>\n</tool_call>";
  const r = extractTextToolCalls(text);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0]!.name, "search");
  assert.deepEqual(r.toolCalls[0]!.input, { query: "专利 无效", limit: "10" });
  assert.equal(r.remainingText, "");
});

test("Qwen XML：连续两个调用解析为两个 tool_call", () => {
  const text =
    "<function=a>\n<parameter=x>1</parameter>\n</function>\n<function=b>\n<parameter=y>2</parameter>\n</function>";
  const r = extractTextToolCalls(text);
  assert.equal(r.toolCalls.length, 2);
  assert.equal(r.toolCalls[0]!.name, "a");
  assert.equal(r.toolCalls[1]!.name, "b");
});

test("Qwen XML：截断（缺 </function>）→ partialToolCall，parseError=true", () => {
  const r = extractTextToolCalls("<function=search>\n<parameter=query>截断的参数</parameter>");
  assert.deepEqual(r.toolCalls, []);
  assert.equal(r.partialToolCall?.format, "qwen_xml");
  assert.equal(r.parseError, true);
});

test("DeepSeek DSML：全角竖线标记解析", () => {
  const text =
    '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="read_file">\n<｜DSML｜parameter name="path">/tmp/a.txt</content>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>';
  const r = extractTextToolCalls(text);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0]!.name, "read_file");
  assert.deepEqual(r.toolCalls[0]!.input, { path: "/tmp/a.txt" });
});

test("Hermes JSON-in-XML：嵌套对象 arguments 正确反序列化（字符串内花括号边界）", () => {
  const text =
    '<tool_call>\n{"name": "search", "arguments": {"nested": {"a": 1, "b": [1, 2]}, "note": "包含 } 字符"}}\n</tool_call>';
  const r = extractTextToolCalls(text);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0]!.name, "search");
  assert.deepEqual(r.toolCalls[0]!.input, { nested: { a: 1, b: [1, 2] }, note: "包含 } 字符" });
});

test("Hermes：括号平衡但 JSON 语法非法 → partialToolCall invalid_json_inside_tool_call", () => {
  const r = extractTextToolCalls('<tool_call>\n{"name": "broken", "arguments": {bad}}\n</tool_call>');
  assert.deepEqual(r.toolCalls, []);
  assert.equal(r.partialToolCall?.format, "hermes_json");
  assert.equal(r.partialToolCall?.reason, "invalid_json_inside_tool_call");
});

test("Hermes：截断缺 </tool_call> → partialToolCall", () => {
  const r = extractTextToolCalls('<tool_call>\n{"name": "search", "arguments": {"q": "abc"}');
  assert.deepEqual(r.toolCalls, []);
  assert.equal(r.partialToolCall?.format, "hermes_json");
});

test("Mistral：[TOOL_CALLS] JSON 数组解析（转义引号/嵌套）", () => {
  const text =
    '[TOOL_CALLS] [{"name":"a","arguments":{"x":1}},{"name":"b","arguments":{"escaped":"{\\"k\\":\\"v\\"}","arr":[1,{"z":3}]}}]';
  const r = extractTextToolCalls(text);
  assert.equal(r.toolCalls.length, 2);
  assert.equal(r.toolCalls[0]!.name, "a");
  assert.deepEqual(r.toolCalls[1]!.input, { escaped: '{"k":"v"}', arr: [1, { z: 3 }] });
});

test("Mistral：JSON 数组内无 name 字符串项 → partialToolCall tool_calls_array_without_names", () => {
  const r = extractTextToolCalls("[TOOL_CALLS] [1,2]");
  assert.deepEqual(r.toolCalls, []);
  assert.equal(r.partialToolCall?.reason, "tool_calls_array_without_names");
});

test("Llama：<|python_tag|> 对象解析", () => {
  const text = '<|python_tag|>{"name": "calc", "parameters": {"expr": "1+2"}}';
  const r = extractTextToolCalls(text);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0]!.name, "calc");
  assert.deepEqual(r.toolCalls[0]!.input, { expr: "1+2" });
});

test("混合文本：工具调用后的内容保留在 remainingText", () => {
  const text = "先分析，<function=cmd>\n<parameter=shell>ls</parameter>\n</function> 然后继续说话";
  const r = extractTextToolCalls(text);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0]!.name, "cmd");
  assert.equal(r.remainingText, "先分析， 然后继续说话");
});
