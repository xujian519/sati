import assert from "node:assert/strict";
import test from "node:test";
import { countTokens, countTokensGuarded, resetTokenCache } from "../../../src/context/budget/tokenizer.js";

/**
 * CJK token 计数微基准门禁（docs/workbuddy-sati-performance-analysis-review.md
 * 第三批 #16）。
 *
 * 背景：js-tiktoken/lite 对高重复度文本（尤其中文重复模式）的 encode 呈二次方
 * 退化——实测 16KB 重复中文 ≈ 134s、自然语言同长度仅 ~0.14s。第一批已用
 * 内容级 sha1 缓存 + 病态抽样外推兜底。本文件用宽松阈值（秒级）守住"不会回退
 * 成分钟级阻塞"的底线，CI 慢机也不会误报。
 */

test("CJK 微基准：高重复病态文本走抽样外推且不阻塞（<5s）", { timeout: 30_000 }, () => {
  resetTokenCache();
  // ~40KB 高度重复中文（BPE 二次方退化场景）。无抽样兜底时此处会阻塞约 20+ 分钟。
  const text = "专利权利要求书技术方案实施例".repeat(1024);
  const t0 = performance.now();
  const { tokens, mode } = countTokensGuarded(text);
  const elapsed = performance.now() - t0;
  assert.equal(mode, "sample", "高重复 CJK 长文本应判定病态并抽样外推");
  assert.ok(tokens > 0, "外推结果应为正数");
  assert.ok(elapsed < 5_000, `病态文本计数应 <5s（实际 ${elapsed.toFixed(0)}ms）——防二次方退化回潮`);
});

test("CJK 微基准：低重复长文本全量编码且不阻塞（<5s）", { timeout: 30_000 }, () => {
  resetTokenCache();
  // ~45KB 低重复中文散文（每段带唯一序号，破坏重复模式）。
  const units = [
    "本实施例涉及一种用于提高检索效率的方法，该方法通过构建语义索引来加速查询过程。",
    "在另一个方面，系统还支持多种查询模式的组合使用，从而在不同场景下取得稳定的召回效果。",
    "同时，本发明还提供了一种文档重排策略，根据用户的历史行为对候选结果进行个性化排序。",
    "此外，本方法还包括对查询意图进行识别的步骤，以决定采用关键词检索还是语义检索。",
    "在优选方案中，上述语义索引基于预训练的向量模型构建，并支持增量更新。",
  ];
  const text = Array.from({ length: 240 }, (_, i) => `${units[i % units.length]}（第${i}段）`).join("\n");
  const t0 = performance.now();
  const { tokens, mode } = countTokensGuarded(text);
  const elapsed = performance.now() - t0;
  assert.equal(mode, "full", "低重复自然语言应全量编码（样本不超阈值）");
  assert.ok(tokens > 0);
  assert.ok(elapsed < 5_000, `自然语言计数应 <5s（实际 ${elapsed.toFixed(0)}ms）`);
});

test("CJK 微基准：缓存命中（同文本二次计数 <200ms，不触发 encode）", { timeout: 30_000 }, () => {
  resetTokenCache();
  // 病态文本首遇走抽样（较慢），二次计数应纯 sha1 命中。
  const text = "专利权利要求书技术方案实施例".repeat(512);
  const first = countTokensGuarded(text);
  assert.equal(first.mode, "sample");
  const t0 = performance.now();
  const second = countTokens(text);
  const elapsed = performance.now() - t0;
  assert.equal(second, first.tokens);
  assert.ok(elapsed < 200, `缓存命中应 <200ms（实际 ${elapsed.toFixed(0)}ms）`);
});

test("CJK 微基准：1KB 以内文本不做抽样（直接全量编码）", () => {
  resetTokenCache();
  const text = "专利权利要求书技术方案实施例".repeat(30); // 390 字符 < 1024
  const { mode } = countTokensGuarded(text);
  assert.equal(mode, "full", "短文本不触发抽样路径");
});
