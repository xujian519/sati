/**
 * tokenizer 冷启动判据（#450 §3.6）。
 *
 * 抽样兜底的判据是「样本编码耗时 > 80ms ⇒ 病态输入」。冷进程首次编码要构造 Tiktoken
 * （rank 表 + wasm 初始化）+ 预热编码路径，这段成本与输入重复度无关，却会被算进样本
 * 计时：自然语言样本被误判成病态 → 密度外推 → 长文本 token 数被低估近四成，且结果进
 * 内容缓存永不纠正（本机实测 system prompt 9,494 → 5,736）。修复是"取样两次只计第二次"。
 *
 * ⚠️ 本文件必须保持**只含冷启动相关断言**：node:test 每个文件一个进程，文件里任何先于
 * 断言触达 tokenizer 的代码都会替我们把冷启动消化掉，让用例失去意义。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { countTokensGuarded, getTokenizer } from "../../src/context/budget/tokenizer.js";

/** 与判据阈值配套的自然语言样本（> SAMPLE_CHARS = 512）。 */
const NATURAL_TEXT = `${"The patent specification shall describe the invention in a manner sufficiently clear and complete for a person skilled in the art to carry it out. ".repeat(12)}`;

test("冷进程首调长自然语言文本走全量编码，不因初始化成本被外推", () => {
  const result = countTokensGuarded(NATURAL_TEXT);

  // 判据（可观测）：不是 "sample" ——被外推的 token 数不再等于真实值。
  assert.equal(result.mode, "full");
});

test("同内容二次调用命中缓存，结果与首调逐字一致", () => {
  const again = countTokensGuarded(NATURAL_TEXT);
  const exact = getTokenizer().encode(NATURAL_TEXT, [], []).length;

  assert.equal(again.mode, "full");
  assert.equal(again.tokens, exact);
});

test("病态重复输入的抽样保护仍然生效（修复没有削掉兜底）", () => {
  const pathological = "啊".repeat(20_000);
  const result = countTokensGuarded(pathological);

  // 20k 重复字符的全量编码是分钟级（BPE 二次方退化），必须仍走样本外推。
  assert.equal(result.mode, "sample");
  assert.ok(result.tokens > 0);
});
