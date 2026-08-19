import { createHash } from "node:crypto";
import { Tiktoken } from "js-tiktoken/lite";
import o200k_base from "js-tiktoken/ranks/o200k_base";

let _instance: Tiktoken | null = null;

export function getTokenizer(): Tiktoken {
  if (!_instance) {
    _instance = new Tiktoken(o200k_base);
  }
  return _instance;
}

/**
 * 内容级 token 计数缓存（LRU 上限）。
 *
 * 背景（见 docs/workbuddy-sati-performance-analysis-review.md P0-1/2/3）：
 * - 每轮对话都会对全部历史消息重新编码 token（内容未变也重算），随对话长度
 *   线性恶化；
 * - js-tiktoken/lite 对高重复度文本呈二次方退化（实测 16KB 重复中文 ≈ 134s，
 *   自然语言同长度仅 ~0.14s）——BPE 合并链在重复模式下不会提前终止。
 *
 * 缓存保证相同内容全进程只编码一次；抽样兜底保证病态（高重复度）长文本
 * 首遇时按样本密度外推，避免一次性分钟级阻塞。
 */
const TOKEN_CACHE_MAX = 4096;
const tokenCache = new Map<string, number>();

/**
 * 超过该长度时先编码样本试探（按 UTF-16 code unit 计）。
 * 512 字符：病态重复文本样本编码约数百 ms（实测重复中文 ≈ 130ms），
 * 自然语言仅 ≈ 4ms；比 1KB 样本便宜 4 倍，降低 CI 并行争用下的抖动。
 */
const SAMPLE_CHARS = 512;
/** 样本编码超过该耗时即判定为病态输入，改用密度外推。自然语言 512 字符 ≈ 4ms，病态 ≥ 数十 ms。 */
const PATHOLOGICAL_SAMPLE_THRESHOLD_MS = 80;

function cacheKey(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function cacheGet(key: string): number | undefined {
  const cached = tokenCache.get(key);
  if (cached === undefined) return undefined;
  // LRU：命中刷新访问顺序
  tokenCache.delete(key);
  tokenCache.set(key, cached);
  return cached;
}

function cacheSet(key: string, tokens: number): void {
  tokenCache.set(key, tokens);
  if (tokenCache.size > TOKEN_CACHE_MAX) {
    const oldest = tokenCache.keys().next().value;
    if (oldest !== undefined) tokenCache.delete(oldest);
  }
}

/**
 * Count the number of tokens in a text string using o200k_base encoding.
 * Returns 0 for empty strings without invoking the tokenizer.
 */
export function countTokens(text: string): number {
  return countTokensGuarded(text).tokens;
}

/**
 * 带抽样兜底的计数。mode 报告本次结果来自「全量编码」还是「样本外推」，
 * 供测试与诊断区分路径。
 */
export function countTokensGuarded(text: string): { tokens: number; mode: "full" | "sample" } {
  if (text.length === 0) return { tokens: 0, mode: "full" };
  const key = cacheKey(text);
  const cached = cacheGet(key);
  if (cached !== undefined) return { tokens: cached, mode: "full" };

  let tokens: number;
  let mode: "full" | "sample" = "full";
  if (text.length > SAMPLE_CHARS) {
    const sample = text.slice(0, SAMPLE_CHARS);
    const t0 = performance.now();
    const sampleTokens = getTokenizer().encode(sample).length;
    if (performance.now() - t0 > PATHOLOGICAL_SAMPLE_THRESHOLD_MS) {
      // 高重复度文本（BPE 二次方退化）：按样本密度外推，避免分钟级阻塞。
      tokens = Math.max(1, Math.round((sampleTokens * text.length) / sample.length));
      mode = "sample";
    } else {
      tokens = getTokenizer().encode(text).length;
    }
  } else {
    tokens = getTokenizer().encode(text).length;
  }
  cacheSet(key, tokens);
  return { tokens, mode };
}

/** 测试/诊断用：清空内容缓存。 */
export function resetTokenCache(): void {
  tokenCache.clear();
}
