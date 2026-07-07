import assert from "node:assert/strict";
import test from "node:test";

import { extractTextToolCalls } from "../../../src/model/streaming/parseTextToolCalls.js";

test("Qwen XML fallback extracts complete function calls", () => {
  const parsed = extractTextToolCalls(
    "<function=bash><parameter=command>echo hi</parameter></function>",
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0]?.name, "bash");
  assert.deepEqual(parsed.toolCalls[0]?.input, { command: "echo hi" });
  assert.equal(parsed.partialToolCall, undefined);
});

test("orphan Qwen XML closing tags are partial, not executable", () => {
  const parsed = extractTextToolCalls("</parameter>\n</function>");

  assert.equal(parsed.toolCalls.length, 0);
  assert.equal(parsed.partialToolCall?.format, "qwen_xml");
  assert.equal(parsed.partialToolCall?.reason, "orphan_qwen_function_close");
});

test("orphan Qwen XML parameters are partial, not executable", () => {
  const parsed = extractTextToolCalls("<parameter=description>x</parameter>\n</function>");

  assert.equal(parsed.toolCalls.length, 0);
  assert.equal(parsed.partialToolCall?.format, "qwen_xml");
  assert.equal(parsed.partialToolCall?.reason, "orphan_qwen_parameter");
});

test("Qwen XML fallback records dangling fragments after complete calls", () => {
  const parsed = extractTextToolCalls(
    "<function=bash><parameter=command>echo hi</parameter></function>\n</parameter>\n</function>",
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0]?.name, "bash");
  assert.equal(parsed.partialToolCall?.format, "qwen_xml");
  assert.equal(parsed.partialToolCall?.reason, "orphan_qwen_function_close");
});

test("better0626 isolated Qwen XML fragments are all classified as partial", () => {
  const samples = [
    { text: "\n\n\n</parameter>\n</function>\n", reason: "orphan_qwen_function_close" },
    { text: "\n\n</parameter>\n</function>\n", reason: "orphan_qwen_function_close" },
    { text: "\n</parameter>\n</function>\n", reason: "orphan_qwen_function_close" },
    {
      text: "\n\n</parameter>\n<parameter=timeout>\n30000\n</parameter>\n<parameter=description>\nWrite improved solve script v2\n</parameter>\n</parameter>\n</function>\n",
      reason: "orphan_qwen_parameter",
    },
    {
      text: "</parameter>\n<parameter=description>\nRun solve3 to see the error\n</parameter>\n<parameter=description>\nCheck solve3 error\n</parameter>\n</function>",
      reason: "orphan_qwen_parameter",
    },
    {
      text: "\n</parameter>\n<parameter=description>\nExtract metadata from video container\n</parameter>\n</function>\n",
      reason: "orphan_qwen_parameter",
    },
  ];

  for (const sample of samples) {
    const parsed = extractTextToolCalls(sample.text);
    assert.equal(parsed.toolCalls.length, 0);
    assert.equal(parsed.partialToolCall?.format, "qwen_xml");
    assert.equal(parsed.partialToolCall?.reason, sample.reason);
  }
});

test("orphan Hermes XML closing tags are partial, not executable", () => {
  const parsed = extractTextToolCalls("</tool_call>");

  assert.equal(parsed.toolCalls.length, 0);
  assert.equal(parsed.partialToolCall?.format, "hermes_json");
  assert.equal(parsed.partialToolCall?.reason, "orphan_hermes_tool_call_close");
});

test("Hermes XML fallback records dangling fragments after complete calls", () => {
  const parsed = extractTextToolCalls(
    '<tool_call>{"name":"read","arguments":{"path":"a.txt"}}</tool_call>\n</tool_call>',
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0]?.name, "read");
  assert.equal(parsed.partialToolCall?.format, "hermes_json");
  assert.equal(parsed.partialToolCall?.reason, "orphan_hermes_tool_call_close");
});

test("orphan DSML XML fragments are partial, not executable", () => {
  const parsed = extractTextToolCalls("</｜DSML｜invoke>\n</｜DSML｜tool_calls>");

  assert.equal(parsed.toolCalls.length, 0);
  assert.equal(parsed.partialToolCall?.format, "deepseek_dsml");
  assert.equal(parsed.partialToolCall?.reason, "orphan_dsml_tool_call_close");
});

test("orphan DSML parameters are partial, not executable", () => {
  const parsed = extractTextToolCalls('<｜DSML｜parameter name="path">a.txt</content>\n</｜DSML｜invoke>');

  assert.equal(parsed.toolCalls.length, 0);
  assert.equal(parsed.partialToolCall?.format, "deepseek_dsml");
  assert.equal(parsed.partialToolCall?.reason, "orphan_dsml_parameter");
});
