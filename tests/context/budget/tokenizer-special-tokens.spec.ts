import test from "node:test";
import assert from "node:assert/strict";
import {
  countTokens,
  countTokensGuarded,
  getTokenizer,
  resetTokenCache,
} from "../../../src/context/budget/tokenizer.js";

/**
 * 特殊 token 字面量必须按普通文本计数（上游 #574 移植）。
 *
 * js-tiktoken 的 `encode` 默认 `disallowedSpecial = "all"`，文本含
 * `<|endoftext|>` 这类字面量时直接抛错。工具输出/文件正文出现这类字面量是
 * 常见情形，预算计算不应因此失败。
 *
 * 抽样兜底分支（> SAMPLE_CHARS = 512）同样必须放行——它编码的是文本前缀。
 */

const LITERAL_TEXT = "a <|endoftext|> b";

test("前置事实：默认参数下特殊 token 字面量会抛错（本修复的存在理由）", () => {
  assert.throws(
    () => getTokenizer().encode(LITERAL_TEXT),
    /special token/,
    "js-tiktoken 默认 disallowedSpecial='all' 应拒绝字面量；若此断言失败说明上游默认值已变，可简化本修复",
  );
});

test("含特殊 token 字面量的短文本计数不抛错", () => {
  resetTokenCache();
  const tokens = countTokens(LITERAL_TEXT);
  assert.equal(typeof tokens, "number");
  assert.ok(tokens > 0, "字面量应按普通文本计数，得到有限且正的 token 数");
});

test("Qwen 模板标记（<|im_start|>/<|im_end|>）同样放行", () => {
  resetTokenCache();
  const text = "<|im_start|>user\n检索式构建<|im_end|>\n<|im_start|>assistant";
  const tokens = countTokens(text);
  assert.ok(tokens > 0);
  assert.equal(countTokensGuarded(text).mode, "full");
});

test("等价性锚：不含字面量的常规文本计数结果与默认参数完全一致", () => {
  resetTokenCache();
  const samples = [
    "专利权利要求书技术方案实施例检索报告",
    "The quick brown fox jumps over the lazy dog.",
    "<think>推理链</think> 正文继续",
  ];
  for (const text of samples) {
    resetTokenCache();
    assert.equal(
      countTokens(text),
      getTokenizer().encode(text).length,
      `常规文本计数不应因放行特殊 token 而改变：${text}`,
    );
  }
});

test("超过抽样阈值的长文本，字面量落在样本区间内也不抛错", () => {
  resetTokenCache();
  // 字面量置于开头（样本区间 = 前 512 字符内），覆盖 sample 编码分支。
  const text = `${LITERAL_TEXT}${"专利检索报告正文".repeat(200)}`;
  assert.ok(text.length > 512, "用例需超过 SAMPLE_CHARS 才会走抽样分支");

  const first = countTokensGuarded(text);
  assert.ok(first.tokens > 0);
  assert.ok(["full", "sample"].includes(first.mode));
});

test("字面量在样本区间之外的长文本同样不抛错", () => {
  resetTokenCache();
  const text = `${"专利检索报告正文".repeat(200)}${LITERAL_TEXT}`;
  assert.ok(text.length > 512);

  const result = countTokensGuarded(text);
  assert.ok(result.tokens > 0);
});

test("含字面量的文本走内容缓存：第二次计数不再编码", () => {
  resetTokenCache();
  const tok = getTokenizer();
  const original = tok.encode.bind(tok);
  let encodeCalls = 0;
  tok.encode = ((...args: Parameters<typeof original>) => {
    encodeCalls += 1;
    return original(...args);
  }) as typeof tok.encode;

  try {
    const first = countTokens(LITERAL_TEXT);
    const second = countTokens(LITERAL_TEXT);
    assert.equal(first, second, "同一文本两次计数结果一致");
    assert.equal(encodeCalls, 1, "相同内容只应编码一次");
  } finally {
    tok.encode = original;
    resetTokenCache();
  }
});

test("空文本仍短路返回 0，不触碰 tokenizer", () => {
  resetTokenCache();
  const tok = getTokenizer();
  const original = tok.encode.bind(tok);
  let encodeCalls = 0;
  tok.encode = ((...args: Parameters<typeof original>) => {
    encodeCalls += 1;
    return original(...args);
  }) as typeof tok.encode;

  try {
    assert.equal(countTokens(""), 0);
    assert.equal(encodeCalls, 0);
  } finally {
    tok.encode = original;
    resetTokenCache();
  }
});
