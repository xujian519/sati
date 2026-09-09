/**
 * 用户输入外发脱敏测试（W1）。
 *
 * 覆盖：三类凭证（API key / URL userinfo / 密码赋值）正反用例、
 * AgentInput 两种形态（text / blocks 仅 text block）、redacted 标记语义。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  REDACTED_API_KEY,
  REDACTED_CREDENTIALS,
  REDACTED_SECURE_TOKEN,
  sanitizeAgentInput,
  sanitizeOutgoingText,
} from "../../src/agent/turn/sanitizeAgentInput.js";

test("sanitizeOutgoingText：API key 命中并替换", () => {
  const { text, redacted } = sanitizeOutgoingText("我的配置是 sk-abcdefghijklmnop123456 请检查");
  assert.equal(redacted, true);
  assert.equal(text, `我的配置是 ${REDACTED_API_KEY} 请检查`);
});

test("sanitizeOutgoingText：各类 key 前缀均命中", () => {
  for (const key of [
    "sk-ant-abcdefghijklmnopqrst",
    "xai-abcdefghijklmnopqrst",
    "AIzaSyA1234567890abcd",
    "ghp_abcdefghijklmnopqrst",
    "gho_abcdefghijklmnopqrst",
    "glpat_-abcdefghijklmnopqrs",
  ]) {
    const { redacted } = sanitizeOutgoingText(`token: ${key}`);
    assert.equal(redacted, true, key);
  }
});

test("sanitizeOutgoingText：短串与普通文本不误伤", () => {
  for (const text of [
    "sk-47",
    "sk-",
    "编号 sk-1234 不构成密钥",
    "CH3-CH2-OH 化学式 sk-short",
    "普通段落，无任何凭证内容",
  ]) {
    const result = sanitizeOutgoingText(text);
    assert.equal(result.redacted, false, text);
    assert.equal(result.text, text);
  }
});

test("sanitizeOutgoingText：URL userinfo 凭证替换", () => {
  const { text, redacted } = sanitizeOutgoingText("见 https://user:secret@example.com/path");
  assert.equal(redacted, true);
  assert.equal(text, `见 https://user:${REDACTED_CREDENTIALS}@example.com/path`);
});

test("sanitizeOutgoingText：URL userinfo 之外的冒号文本不误伤", () => {
  const text = "比例 a:b@c 附近，时间 12:30，端口 localhost:3001";
  const result = sanitizeOutgoingText(text);
  assert.equal(result.redacted, false);
  assert.equal(result.text, text);
});

test("sanitizeOutgoingText：密码赋值替换", () => {
  const { text, redacted } = sanitizeOutgoingText('password = "hunter2"');
  assert.equal(redacted, true);
  assert.equal(text, `password = "${REDACTED_SECURE_TOKEN}"`);
});

test("sanitizeOutgoingText：password 出现在非赋值语境不误伤", () => {
  const text = "请重置 password 字段后重试";
  const result = sanitizeOutgoingText(text);
  assert.equal(result.redacted, false);
});

test("sanitizeAgentInput：text 形态透传与脱敏", () => {
  const clean = sanitizeAgentInput({ type: "text", text: "普通问题" });
  assert.equal(clean.redacted, false);
  assert.deepEqual(clean.input, { type: "text", text: "普通问题" });

  const dirty = sanitizeAgentInput({ type: "text", text: "key: sk-abcdefghijklmnop1234" });
  assert.equal(dirty.redacted, true);
  assert.equal(dirty.input.type, "text");
  if (dirty.input.type === "text") {
    assert.equal(dirty.input.text, `key: ${REDACTED_API_KEY}`);
  }
});

test("sanitizeAgentInput：blocks 形态仅脱敏 text block", () => {
  const imageBlock = {
    type: "image",
    source: "base64",
    data: "aGVsbG8=",
    mimeType: "image/png",
  } as const;
  const dirty = sanitizeAgentInput({
    type: "blocks",
    content: [{ type: "text", text: "日志含 https://admin:pass@example.com/api" }, imageBlock],
  });
  assert.equal(dirty.redacted, true);
  if (dirty.input.type === "blocks") {
    assert.equal(dirty.input.content[0]!.type, "text");
    const first = dirty.input.content[0] as { type: "text"; text: string };
    assert.equal(first.text, `日志含 https://admin:${REDACTED_CREDENTIALS}@example.com/api`);
    assert.deepEqual(dirty.input.content[1], imageBlock);
  }
});
