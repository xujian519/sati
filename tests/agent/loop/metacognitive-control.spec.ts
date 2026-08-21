/**
 * metacognitiveControl 测试。
 *
 * 覆盖：置信度标签解析（strong/thin/shaky/无标签）、诊断提取、
 * 重试提示嵌入诊断、prompt 生成非空。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMetacognitivePrompt,
  buildMetacognitiveRetryPrompt,
  parseSelfEstimate,
} from "../../../src/agent/loop/metacognitiveControl.js";

test("parses strong / thin / shaky confidence tags", () => {
  assert.equal(parseSelfEstimate("[confidence: strong] done.").tag, "strong");
  assert.equal(parseSelfEstimate("[confidence: thin] maybe.").tag, "thin");
  assert.equal(parseSelfEstimate("[confidence: shaky] not sure.").tag, "shaky");
});

test("recognizes synonyms", () => {
  assert.equal(parseSelfEstimate("[confidence: confident]").tag, "strong");
  assert.equal(parseSelfEstimate("[estimate: unsure]").tag, "thin");
});

test("no tag returns undefined", () => {
  const result = parseSelfEstimate("I am not sure, but here is my answer.");
  assert.equal(result.tag, undefined);
  assert.equal(result.diagnosis, undefined);
});

test("extracts the diagnosis", () => {
  const result = parseSelfEstimate("[confidence: shaky] [diagnosis: assumed the list is sorted] retry.");
  assert.equal(result.tag, "shaky");
  assert.equal(result.diagnosis, "assumed the list is sorted");
});

test("diagnosis without confidence is still extracted", () => {
  const result = parseSelfEstimate("[diagnosis: the parser misread the input]");
  assert.equal(result.diagnosis, "the parser misread the input");
});

test("retry prompt embeds the diagnosis", () => {
  const prompt = buildMetacognitiveRetryPrompt("assumed the list is sorted");
  assert.ok(prompt.includes("assumed the list is sorted"));
});

test("retry prompt without diagnosis is still meaningful", () => {
  const prompt = buildMetacognitiveRetryPrompt(undefined);
  assert.ok(prompt.includes("weak step"));
});

test("metacognitive prompt is non-empty", () => {
  assert.ok(buildMetacognitivePrompt().length > 20);
});
