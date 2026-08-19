import test from "node:test";
import assert from "node:assert/strict";
import {
  countTokens,
  countTokensGuarded,
  getTokenizer,
  resetTokenCache,
} from "../../../src/context/budget/tokenizer.js";

/**
 * 内容级 token 计数缓存（P0-1 根治）：相同文本全进程只编码一次；
 * 病态（高重复度）长文本走样本外推，避免 js-tiktoken BPE 二次方退化。
 */

test("相同文本第二次计数不再调用 tokenizer encode（缓存命中）", () => {
  resetTokenCache();
  const tok = getTokenizer();
  const original = tok.encode.bind(tok);
  let encodeCalls = 0;
  tok.encode = ((text: string) => {
    encodeCalls += 1;
    return original(text);
  }) as typeof tok.encode;

  try {
    const text = "专利权利要求书技术方案实施例检索报告".repeat(50);
    const first = countTokens(text);
    const second = countTokens(text);
    assert.equal(first, second, "同一文本两次计数结果一致");
    assert.equal(encodeCalls, 1, "相同内容只应编码一次");
  } finally {
    tok.encode = original;
    resetTokenCache();
  }
});

test("不同文本各自编码一次，互不串扰", () => {
  resetTokenCache();
  const tok = getTokenizer();
  const original = tok.encode.bind(tok);
  let encodeCalls = 0;
  tok.encode = ((text: string) => {
    encodeCalls += 1;
    return original(text);
  }) as typeof tok.encode;

  try {
    countTokens("alpha 专利文本");
    countTokens("beta 专利文本");
    assert.equal(encodeCalls, 2);
  } finally {
    tok.encode = original;
    resetTokenCache();
  }
});

test("空文本不触碰 tokenizer", () => {
  resetTokenCache();
  const tok = getTokenizer();
  const original = tok.encode.bind(tok);
  let encodeCalls = 0;
  tok.encode = ((text: string) => {
    encodeCalls += 1;
    return original(text);
  }) as typeof tok.encode;

  try {
    assert.equal(countTokens(""), 0);
    assert.equal(countTokens(""), 0);
    assert.equal(encodeCalls, 0);
  } finally {
    tok.encode = original;
    resetTokenCache();
  }
});

test("高重复度长文本走样本外推路径（mode=sample），且计数与全量编码同数量级", () => {
  resetTokenCache();
  // 病态样本：超过采样长度的高度重复中文模式文本（BPE 合并链不提前终止，
  // 实测 512 字符样本编码 ≈ 130ms，远超 80ms 阈值）。
  const pathological = "专利权利要求书技术方案实施例".repeat(400); // 400 × 14 chars ≈ 5.6KB
  assert.ok(pathological.length > 1024);
  const guarded = countTokensGuarded(pathological);
  assert.equal(guarded.mode, "sample", "病态输入应走外推");
  assert.ok(guarded.tokens > 0);

  // 外推密度应与小样本全量编码密度接近（同模式文本密度恒定）。
  const sampleTokens = getTokenizer().encode(pathological.slice(0, 256)).length;
  const expected = Math.round((sampleTokens * pathological.length) / 256);
  const ratio = guarded.tokens / expected;
  assert.ok(ratio > 0.5 && ratio < 2, `外推值 ${guarded.tokens} 应接近按密度推算 ${expected}`);
});

test("自然语言长文本走全量编码路径（mode=full）", () => {
  resetTokenCache();
  const prose =
    "本发明涉及一种基于深度学习的专利价值评估方法，通过构建多层神经网络模型，对专利文本进行语义特征提取。" +
    "与现有技术相比，本方法显著提升了评估的准确性和鲁棒性，可广泛应用于专利导航、技术转移与知识产权运营等场景。";
  const text = prose.repeat(80); // > 1KB 自然语言
  assert.ok(text.length > 1024);
  const guarded = countTokensGuarded(text);
  assert.equal(guarded.mode, "full", "自然语言样本编码快，应走全量");
  // 与逐段求和一致（无 padding，纯编码一致性）
  const direct = countTokensGuarded(text).tokens;
  assert.equal(direct, guarded.tokens);
});

test("缓存 LRU 上限生效：超出上限后最早条目被淘汰（内存有界）", () => {
  resetTokenCache();
  // 注入超过上限的独有文本（每次计数都编码一次并写入缓存）。
  for (let i = 0; i < 4200; i++) {
    countTokens(`unique-text-${i}-专利内容`);
  }
  // 早于上限的条目应已被淘汰：再计数会重新编码（无缓存命中可观察 encode 调用）。
  const tok = getTokenizer();
  const original = tok.encode.bind(tok);
  let encodeCalls = 0;
  tok.encode = ((text: string) => {
    encodeCalls += 1;
    return original(text);
  }) as typeof tok.encode;
  try {
    countTokens("unique-text-0-专利内容");
    assert.equal(encodeCalls, 1, "被淘汰的条目应重新编码");
  } finally {
    tok.encode = original;
    resetTokenCache();
  }
});
