/**
 * src/patent/workflow — 一致性回退信号判定（纯函数）。
 *
 * 从 workflow.ts 拆出（A7 轮次 2）：信号正则编译/缓存 + 触发判定，
 * 独立可单测（否定词窗口、句界排除、g-flag lastIndex 重置语义锁定）。
 */

import type { WorkflowStage } from "./types.js";

/**
 * 信号触发判定：匹配位置前窗口内出现否定词（不/未/无/没，无句界分隔）
 * 时视为否定性表述（"未发现不一致""不缺少任何特征"），不触发回退。
 *
 * JSON 感知（2026-08 修复）：输出为 JSON 对象且含布尔 consistent 字段时，
 * 以机器可读判据为准——consistent:false 直接命中回退（绕开否定词窗口对
 * issues 文案措辞的误判，如"无效果关联，孤立"中"孤立"前窗口含"无"），
 * consistent:true 不命中；非 JSON / 无该字段回退关键词扫描。
 */
export function signalMatches(text: string, signal: RegExp): boolean {
  const consistent = tryParseConsistentField(text);
  if (consistent !== undefined) return !consistent;
  let match: RegExpExecArray | null;
  const RE = /[不未无没]/;
  signal.lastIndex = 0; // 带 g 标志的正则跨调用保留 lastIndex：回退重入前必须重置，否则 exec 直接返回 null
  while ((match = signal.exec(text)) !== null) {
    const start = Math.max(0, match.index - 12);
    const before = text.slice(start, match.index);
    if (!before.includes("。") && !before.includes("；") && !before.includes(";") && !RE.test(before)) {
      return true;
    }
    if (match[0].length === 0) signal.lastIndex += 1;
  }
  return false;
}

/** 尝试从输出文本解析 consistent 布尔字段（严格 JSON 对象；非布尔/解析失败返回 undefined）。 */
function tryParseConsistentField(text: string): boolean | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const value = (parsed as Record<string, unknown>).consistent;
      return typeof value === "boolean" ? value : undefined;
    }
  } catch {
    // 非严格 JSON（LLM 输出杂散文本）：回退关键词扫描。
  }
  return undefined;
}

/** 编译信号正则（g 标志必需：signalMatches 用 exec 遍历全部匹配位置，无 g 时 exec 每次从头匹配 → 死循环）。 */
export function compileSignal(pattern: string): RegExp {
  return new RegExp(pattern, "gi");
}

/** 带缓存的信号获取（按阶段 id 缓存，避免每次执行/回退重新编译）。 */
export function signalFor(stage: WorkflowStage, cache: Map<string, RegExp>): RegExp | undefined {
  if (stage.retry === undefined) return undefined;
  const cached = cache.get(stage.id);
  if (cached !== undefined) return cached;
  const compiled = compileSignal(stage.retry.whenOutputMatches);
  cache.set(stage.id, compiled);
  return compiled;
}
